import type { Credentials } from '@/persistence';
import { fetchEncryptedTranscriptPageAfterSeq } from '@/api/session/fetchEncryptedTranscriptWindow';
import type { TranscriptRow } from '@/api/session/fetchEncryptedTranscriptWindow';
import { listPendingQueueV2LocalIdsFromServer } from '@/api/session/pendingQueueV2Transport';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { decryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

export type ControlledEvidenceRow = Readonly<{
  seq: number;
  kind: 'user' | 'assistant_output' | 'task_complete' | 'task_failed'
    | 'compact_started' | 'compact_completed' | 'switch_event';
  localId?: string;
  lifecycleId?: string;
  providerEventId?: string;
  toProfileId?: string;
  actionId?: string;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function hasAnswerText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!Array.isArray(value)) return false;
  return value.some((block) => {
    const rec = asRecord(block);
    return rec?.type === 'text' && typeof rec.text === 'string' && rec.text.trim().length > 0;
  });
}

export function projectControlledEvidenceRows(rows: readonly TranscriptRow[],
  decrypt: (ciphertextBase64: string) => unknown): ControlledEvidenceRow[] {
  const result: ControlledEvidenceRow[] = [];
  const seen = new Set<number>();
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (!Number.isSafeInteger(row.seq) || row.seq < 0 || seen.has(row.seq)) {
      throw new Error('Invalid or duplicate transcript sequence');
    }
    seen.add(row.seq);
    const payload = asRecord(row.content.t === 'plain'
      ? row.content.v : decrypt(row.content.c));
    if (!payload) throw new Error('Unusable transcript event');
    const content = asRecord(payload.content);
    if (payload.role === 'user') {
      if (!row.localId) throw new Error('User event without localId');
      result.push({ seq: row.seq, kind: 'user', localId: row.localId });
      continue;
    }
    if (payload.role !== 'agent' && payload.role !== 'assistant') continue;
    const data = asRecord(content?.data);
    if (content?.type === 'acp' && data?.type === 'task_complete') {
      result.push({ seq: row.seq, kind: 'task_complete' });
    } else if (content?.type === 'acp' && (
      data?.type === 'task_failed' || data?.type === 'task_cancelled' || data?.type === 'task_aborted')) {
      result.push({ seq: row.seq, kind: 'task_failed' });
    } else if (content?.type === 'output' && data?.type === 'assistant'
        && hasAnswerText(asRecord(data.message)?.content)) {
      result.push({ seq: row.seq, kind: 'assistant_output' });
    } else if (content?.type === 'event' && data?.type === 'context-compaction'
        && (data.phase === 'started' || data.phase === 'completed')) {
      const lifecycleId = typeof data.lifecycleId === 'string' ? data.lifecycleId : '';
      if (!lifecycleId) throw new Error('Compaction event without lifecycle ID');
      result.push({ seq: row.seq,
        kind: data.phase === 'started' ? 'compact_started' : 'compact_completed',
        lifecycleId,
        ...(typeof data.providerEventId === 'string' ? { providerEventId: data.providerEventId } : {}),
      });
    } else if (content?.type === 'event' && data?.type === 'connected-service-account-switch') {
      result.push({ seq: row.seq, kind: 'switch_event',
        ...(typeof data.toProfileId === 'string' ? { toProfileId: data.toProfileId } : {}),
        ...(typeof data.controlledActionId === 'string'
          ? { actionId: data.controlledActionId } : {}),
      });
    }
  }
  return result;
}

export async function readControlledSessionEvidence(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  afterSeq: number;
}>): Promise<Readonly<{
  sessionId: string;
  afterSeq: number;
  serverMessageSeq: number;
  pendingLocalIds: string[];
  rows: ControlledEvidenceRow[];
}>> {
  if (!Number.isSafeInteger(params.afterSeq) || params.afterSeq < 0) throw new Error('Invalid evidence cursor');
  const target = await resolveSessionTransportContext({
    credentials: params.credentials, idOrPrefix: params.sessionId,
  });
  if (!target.ok || target.sessionId !== params.sessionId) throw new Error('Evidence session unavailable');
  const all: TranscriptRow[] = [];
  let cursor = params.afterSeq;
  for (let page = 0; page < 4; page += 1) {
    const rows = await fetchEncryptedTranscriptPageAfterSeq({
      token: params.credentials.token, sessionId: params.sessionId,
      afterSeq: cursor, limit: 250,
    });
    if (rows.length === 0) break;
    const ordered = [...rows].sort((a, b) => a.seq - b.seq);
    if (ordered[0]!.seq <= cursor || ordered.at(-1)!.seq <= cursor) {
      throw new Error('Transcript cursor did not advance');
    }
    all.push(...ordered);
    cursor = ordered.at(-1)!.seq;
    if (rows.length < 250) break;
    if (page === 3) throw new Error('Evidence window exceeds 1000 rows');
  }
  const rows = projectControlledEvidenceRows(all, (ciphertextBase64) =>
    decryptSessionPayload({ ctx: target.ctx, ciphertextBase64 }));
  const pendingLocalIds = await listPendingQueueV2LocalIdsFromServer({
    token: params.credentials.token, sessionId: params.sessionId,
  });
  if (pendingLocalIds.length > 1000) throw new Error('Pending evidence too large');
  return {
    sessionId: params.sessionId,
    afterSeq: params.afterSeq,
    serverMessageSeq: typeof target.rawSession.lastMessageSeq === 'number'
      ? target.rawSession.lastMessageSeq : cursor,
    pendingLocalIds,
    rows,
  };
}
