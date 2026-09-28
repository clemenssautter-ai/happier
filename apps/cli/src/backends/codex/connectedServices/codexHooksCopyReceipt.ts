import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export const CODEX_HOOKS_COPY_RECEIPT_NAME = '.happier-codex-hooks-copy-receipt.json';

type FileObservation = Readonly<{
  sha256: string;
  dev: number;
  ino: number;
  regularFile: true;
  symbolicLink: false;
}>;

type SyncObservation = Readonly<{
  nonce: string;
  observedAtMs: number;
  source: FileObservation;
  target: FileObservation;
}>;

type HooksCopyReceipt = Readonly<{
  schemaVersion: 1;
  producer: 'happier.codex.syncCodexConnectedServiceHome';
  sourceCodexHome: string;
  effectiveCodexHome: string;
  loadedModule: Readonly<{ path: string; sha256: string }>;
  ownerProcess: Readonly<{
    pid: number;
    entrypoint: string | null;
    procStartTicks: string | null;
  }>;
  previous: SyncObservation | null;
  previousTargetBeforeSync: FileObservation | null;
  current: SyncObservation;
}>;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function linuxProcessStartTicks(): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile('/proc/self/stat', 'utf8');
    const fieldsAfterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return /^\d+$/.test(fieldsAfterComm[19] ?? '') ? fieldsAfterComm[19] : null;
  } catch {
    return null;
  }
}

async function observeRegularFile(path: string): Promise<FileObservation | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return {
      sha256: sha256(await readFile(path)),
      dev: stat.dev,
      ino: stat.ino,
      regularFile: true,
      symbolicLink: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isFileObservation(value: unknown): value is FileObservation {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)
    && typeof file.dev === 'number' && typeof file.ino === 'number'
    && file.regularFile === true && file.symbolicLink === false;
}

function isSyncObservation(value: unknown): value is SyncObservation {
  if (!value || typeof value !== 'object') return false;
  const sync = value as Record<string, unknown>;
  return typeof sync.nonce === 'string' && sync.nonce.length > 0
    && Number.isSafeInteger(sync.observedAtMs) && Number(sync.observedAtMs) > 0
    && isFileObservation(sync.source) && isFileObservation(sync.target);
}

async function previousObservation(home: string, sourceHome: string): Promise<SyncObservation | null> {
  try {
    const raw = JSON.parse(await readFile(join(home, CODEX_HOOKS_COPY_RECEIPT_NAME), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const receipt = raw as Partial<HooksCopyReceipt>;
    if (receipt.schemaVersion !== 1
      || receipt.producer !== 'happier.codex.syncCodexConnectedServiceHome'
      || receipt.sourceCodexHome !== sourceHome
      || receipt.effectiveCodexHome !== home
      || !isSyncObservation(receipt.current)) return null;
    return receipt.current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Capture the old promoted profile before the descriptor copies the new hooks file. */
export async function capturePreviousCodexHooksCopy(params: Readonly<{
  sourceCodexHome: string;
  destinationCodexHome: string;
  previousCodexHome?: string | null;
}>): Promise<Readonly<{ observation: SyncObservation | null; target: FileObservation | null }>> {
  const effectiveHome = resolve(params.previousCodexHome ?? params.destinationCodexHome);
  const observation = await previousObservation(effectiveHome, resolve(params.sourceCodexHome));
  const target = await observeRegularFile(join(effectiveHome, 'hooks.json'));
  return { observation, target };
}

/** Emit only hash and inode observations; hook contents and credentials stay out of the receipt. */
export async function writeCodexHooksCopyReceipt(params: Readonly<{
  sourceCodexHome: string;
  destinationCodexHome: string;
  previousCodexHome?: string | null;
  previous: Awaited<ReturnType<typeof capturePreviousCodexHooksCopy>>;
}>): Promise<void> {
  const sourceHome = resolve(params.sourceCodexHome);
  const destinationHome = resolve(params.destinationCodexHome);
  const receiptPath = join(destinationHome, CODEX_HOOKS_COPY_RECEIPT_NAME);
  const source = await observeRegularFile(join(sourceHome, 'hooks.json'));
  const target = await observeRegularFile(join(destinationHome, 'hooks.json'));
  if (!source || !target || source.sha256 !== target.sha256) {
    await rm(receiptPath, { force: true });
    return;
  }
  const modulePath = fileURLToPath(import.meta.url);
  const previous = params.previous.observation;
  const priorTarget = params.previous.target;
  const validPrevious = previous && priorTarget
    && previous.source.sha256 === previous.target.sha256
    && previous.target.sha256 === priorTarget.sha256
    ? previous : null;
  const receipt: HooksCopyReceipt = {
    schemaVersion: 1,
    producer: 'happier.codex.syncCodexConnectedServiceHome',
    sourceCodexHome: sourceHome,
    effectiveCodexHome: resolve(params.previousCodexHome ?? params.destinationCodexHome),
    loadedModule: { path: modulePath, sha256: sha256(await readFile(modulePath)) },
    ownerProcess: {
      pid: process.pid,
      entrypoint: process.argv[1] ? resolve(process.argv[1]) : null,
      procStartTicks: await linuxProcessStartTicks(),
    },
    previous: validPrevious,
    previousTargetBeforeSync: validPrevious ? priorTarget : null,
    current: {
      nonce: randomUUID(),
      observedAtMs: Date.now(),
      source,
      target,
    },
  };
  await writeJsonAtomic(receiptPath, receipt);
}
