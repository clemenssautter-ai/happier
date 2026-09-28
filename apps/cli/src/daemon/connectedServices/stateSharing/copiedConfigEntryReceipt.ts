import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export const COPIED_CONFIG_ENTRY_RECEIPT_NAME = '.happier-state-sharing-copy-receipt.json';

type FileObservation = Readonly<{
  sha256: string;
  dev: number;
  ino: number;
  regularFile: true;
  symbolicLink: false;
}>;
type EntryObservation = Readonly<{ source: FileObservation; target: FileObservation }>;
type SyncObservation = Readonly<{
  nonce: string;
  observedAtMs: number;
  entries: Readonly<Record<string, EntryObservation>>;
}>;
type CopyReceipt = Readonly<{
  schemaVersion: 1;
  producer: 'happier.connectedServices.materialize';
  sourceRoot: string;
  effectiveRoot: string;
  loadedModule: Readonly<{ path: string; sha256: string }>;
  ownerProcess: Readonly<{ pid: number; entrypoint: string | null; procStartTicks: string | null }>;
  previous: SyncObservation | null;
  previousTargetBeforeSync: Readonly<Record<string, FileObservation>> | null;
  current: SyncObservation;
}>;

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function observe(path: string): Promise<FileObservation | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return {
      sha256: hash(await readFile(path)),
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
    && Number.isSafeInteger(file.dev) && Number.isSafeInteger(file.ino)
    && file.regularFile === true && file.symbolicLink === false;
}

function isSyncObservation(value: unknown, entryNames: readonly string[]): value is SyncObservation {
  if (!value || typeof value !== 'object') return false;
  const sync = value as Record<string, unknown>;
  if (typeof sync.nonce !== 'string' || !sync.nonce
    || !Number.isSafeInteger(sync.observedAtMs)
    || !sync.entries || typeof sync.entries !== 'object') return false;
  const entries = sync.entries as Record<string, unknown>;
  return entryNames.every((name) => {
    const entry = entries[name];
    if (!entry || typeof entry !== 'object') return false;
    const observed = entry as Record<string, unknown>;
    return isFileObservation(observed.source) && isFileObservation(observed.target);
  });
}

async function priorObservation(params: Readonly<{
  sourceRoot: string;
  effectiveRoot: string;
  entryNames: readonly string[];
}>): Promise<SyncObservation | null> {
  try {
    const raw = JSON.parse(await readFile(
      join(params.effectiveRoot, COPIED_CONFIG_ENTRY_RECEIPT_NAME), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const receipt = raw as Partial<CopyReceipt>;
    if (receipt.schemaVersion !== 1
      || receipt.producer !== 'happier.connectedServices.materialize'
      || receipt.sourceRoot !== params.sourceRoot
      || receipt.effectiveRoot !== params.effectiveRoot
      || !isSyncObservation(receipt.current, params.entryNames)) return null;
    return receipt.current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function linuxProcessStartTicks(): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile('/proc/self/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? '') ? fields[19] : null;
  } catch {
    return null;
  }
}

/** The owner records only byte and inode continuity for declared forced copies. */
export async function writeCopiedConfigEntryReceipt(params: Readonly<{
  sourceRoot: string;
  stagedRoot: string;
  effectiveRoot: string;
  entryNames: readonly string[];
}>): Promise<void> {
  const sourceRoot = resolve(params.sourceRoot);
  const stagedRoot = resolve(params.stagedRoot);
  const effectiveRoot = resolve(params.effectiveRoot);
  if (sourceRoot === effectiveRoot || stagedRoot === effectiveRoot) {
    throw new Error('Copied config entry receipt requires distinct source, stage and effective roots');
  }
  const names = [...new Set(params.entryNames)].filter((name) =>
    name.length > 0 && !name.startsWith('/') && !name.split(/[\\/]+/).includes('..'));
  if (names.length === 0) return;

  const entries: Record<string, EntryObservation> = {};
  const previousTargets: Record<string, FileObservation> = {};
  for (const name of names) {
    const [source, target, previousTarget] = await Promise.all([
      observe(join(sourceRoot, name)),
      observe(join(stagedRoot, name)),
      observe(join(effectiveRoot, name)),
    ]);
    if (!source || !target || source.sha256 !== target.sha256) continue;
    entries[name] = { source, target };
    if (previousTarget) previousTargets[name] = previousTarget;
  }
  if (Object.keys(entries).length === 0) return;
  const previousCandidate = await priorObservation({
    sourceRoot, effectiveRoot, entryNames: Object.keys(entries),
  });
  const previous = previousCandidate && Object.entries(entries).every(([name]) => {
    const old = previousCandidate.entries[name];
    const before = previousTargets[name];
    return old && before && old.source.sha256 === old.target.sha256
      && old.target.sha256 === before.sha256;
  }) ? previousCandidate : null;
  const modulePath = fileURLToPath(import.meta.url);
  const receipt: CopyReceipt = {
    schemaVersion: 1,
    producer: 'happier.connectedServices.materialize',
    sourceRoot,
    effectiveRoot,
    loadedModule: { path: modulePath, sha256: hash(await readFile(modulePath)) },
    ownerProcess: {
      pid: process.pid,
      entrypoint: process.argv[1] ? resolve(process.argv[1]) : null,
      procStartTicks: await linuxProcessStartTicks(),
    },
    previous,
    previousTargetBeforeSync: previous ? previousTargets : null,
    current: {
      nonce: randomUUID(),
      observedAtMs: Math.max(Date.now(), (previous?.observedAtMs ?? 0) + 1),
      entries,
    },
  };
  await writeJsonAtomic(join(stagedRoot, COPIED_CONFIG_ENTRY_RECEIPT_NAME), receipt);
}
