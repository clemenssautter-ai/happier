import { describe, expect, it } from 'vitest';
import type { TranscriptRow } from '@/api/session/fetchEncryptedTranscriptWindow';
import { projectControlledEvidenceRows } from './controlledSessionEvidence';

const row = (seq: number, localId: string | null, value: unknown): TranscriptRow => ({
  seq, createdAt: 1, localId, content: { t: 'plain', v: value },
});

describe('controlled session evidence', () => {
  it('projects only sequence and lifecycle proof, never the transcript text', () => {
    const rows = [
      row(10, 'usage-action-compact', { role: 'user', content: { type: 'text', text: '/compact' } }),
      row(11, null, { role: 'agent', content: { type: 'event', data: {
        type: 'context-compaction', phase: 'started', lifecycleId: 'life-1' } } }),
      row(12, null, { role: 'agent', content: { type: 'event', data: {
        type: 'context-compaction', phase: 'completed', lifecycleId: 'life-1', providerEventId: 'provider-1' } } }),
      row(13, null, { role: 'agent', content: { type: 'output', data: {
        type: 'assistant', message: { content: [{ type: 'text', text: 'PRIVATE ANSWER' }] } } } }),
      row(14, null, { role: 'agent', content: { type: 'acp', data: { type: 'task_complete' } } }),
    ];
    const evidence = projectControlledEvidenceRows(rows, () => null);
    expect(evidence).toEqual([
      { seq: 10, kind: 'user', localId: 'usage-action-compact' },
      { seq: 11, kind: 'compact_started', lifecycleId: 'life-1' },
      { seq: 12, kind: 'compact_completed', lifecycleId: 'life-1', providerEventId: 'provider-1' },
      { seq: 13, kind: 'assistant_output' },
      { seq: 14, kind: 'task_complete' },
    ]);
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE ANSWER');
  });

  it('fails closed on a duplicated sequence or user message without localId', () => {
    const user = row(10, 'local-1', { role: 'user', content: { type: 'text', text: 'one' } });
    expect(() => projectControlledEvidenceRows([user, user], () => null)).toThrow('duplicate');
    expect(() => projectControlledEvidenceRows([
      row(11, null, { role: 'user', content: { type: 'text', text: 'two' } }),
    ], () => null)).toThrow('without localId');
  });

  it('keeps the action ID on a controlled switch event', () => {
    const evidence = projectControlledEvidenceRows([
      row(17, null, { role: 'agent', content: { type: 'event', data: {
        type: 'connected-service-account-switch', toProfileId: 'clemens2',
        controlledActionId: 'action_1234' } } }),
      row(18, null, { role: 'agent', content: { type: 'event', data: {
        type: 'connected-service-account-switch', toProfileId: 'clemens2' } } }),
    ], () => null);
    expect(evidence).toEqual([
      { seq: 17, kind: 'switch_event', toProfileId: 'clemens2', actionId: 'action_1234' },
      { seq: 18, kind: 'switch_event', toProfileId: 'clemens2' },
    ]);
  });
});
