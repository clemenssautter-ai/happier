import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeSync, fsyncSync } from 'node:fs';
import { basename, join } from 'node:path';

function fileFor(activeServerDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) {
    throw new Error('Invalid session input hold target');
  }
  return join(activeServerDir, 'session-input-holds', `${sessionId}.json`);
}

type HoldState = Readonly<{
  actionId: string;
  state: 'held' | 'released' | 'cancelled';
  version: 1 | 2;
  controlledAdmitted: boolean;
  held: boolean;
}>;

function stateFrom(path: string): HoldState | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as { v?: unknown; sessionId?: unknown; actionId?: unknown;
      state?: unknown; controlledAdmitted?: unknown };
    const actionId = candidate.actionId;
    if (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(actionId)) return null;
    if (candidate.v === 2) {
      if (candidate.sessionId !== basename(path, '.json')
          || !['held', 'released', 'cancelled'].includes(candidate.state as string)
          || typeof candidate.controlledAdmitted !== 'boolean') return null;
      const state = candidate.state as HoldState['state'];
      return { actionId, state, version: 2, controlledAdmitted: candidate.controlledAdmitted,
        held: state === 'held' };
    }
    if (candidate.v !== 1) return null;
    const state = candidate.state === 'released' ? 'released' : 'held';
    return { actionId, state, version: 1, controlledAdmitted: false, held: state === 'held' };
  } catch {
    return null;
  }
}

type LockOwner = Readonly<{ pid: number; token: string }>;

function readLockOwner(lock: string): LockOwner | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(lock, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const candidate = (raw as { v?: unknown; pid?: unknown; token?: unknown });
    if (candidate.v !== 1 || !Number.isSafeInteger(candidate.pid)
        || (candidate.pid as number) <= 0
        || typeof candidate.token !== 'string'
        || !/^[A-Za-z0-9_-]{8,128}$/.test(candidate.token)) return null;
    return { pid: candidate.pid as number, token: candidate.token };
  } catch {
    return null;
  }
}

function ownerIsDead(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // EPERM, unsupported platforms and any uncertain result preserve the fence.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function reclaimDeadLock(lock: string): boolean {
  const observed = readLockOwner(lock);
  if (!observed || !ownerIsDead(observed)) return false;
  const claim = `${lock}.reclaim.${observed.token}`;
  const claimant = { pid: process.pid, token: randomUUID() };
  const staged = `${claim}.${claimant.token}.tmp`;
  mkdirSync(staged, { mode: 0o700 });
  const ownerFile = join(staged, 'owner.json');
  try {
    const fd = openSync(ownerFile, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify({ v: 1, ...claimant }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const stagedFd = openSync(staged, 'r');
    try { fsyncSync(stagedFd); } finally { closeSync(stagedFd); }
    if (existsSync(claim)) {
      const previous = readLockOwner(join(claim, 'owner.json'));
      // An empty legacy claim has no provable owner and stays closed.
      if (!previous || !ownerIsDead(previous)) return false;
      // The nonempty retired destination is a permanent ABA fence: a delayed
      // reclaimer cannot rename a successor claim over this owner's tombstone.
      renameSync(claim, `${claim}.retired.${previous.token}`);
    }
    // Both stage and claim are nonempty directories. Rename cannot replace an
    // active claim; a dead claimant can be retired on the next invocation.
    renameSync(staged, claim);
    if (readLockOwner(join(claim, 'owner.json'))?.token !== claimant.token) return false;
    // Another reclaimer may have removed the old lock and a new writer
    // acquired this path. The token-scoped claim remains outside the new lock.
    const current = readLockOwner(lock);
    if (!current || current.pid !== observed.pid || current.token !== observed.token
        || !ownerIsDead(current)) return false;
    unlinkSync(lock);
    return true;
  } catch {
    // Ambiguous ownership or a concurrent claimant remains fail-closed.
    return false;
  } finally {
    if (readLockOwner(join(claim, 'owner.json'))?.token === claimant.token) {
      try { renameSync(claim, `${claim}.retired.${claimant.token}`); } catch { /* Keep claim. */ }
    }
    if (existsSync(staged)) {
      try { unlinkSync(ownerFile); rmdirSync(staged); } catch { /* Inert staging only. */ }
    }
  }
}

export function createSessionInputHoldStore(activeServerDir: string) {
  const holdsDir = join(activeServerDir, 'session-input-holds');
  function withMutationLock(sessionId: string, mutate: () => boolean): boolean {
    const path = fileFor(activeServerDir, sessionId);
    const lock = path.slice(0, -'.json'.length) + '.lock';
    mkdirSync(holdsDir, { recursive: true, mode: 0o700 });
    // Prepare the complete owner record before the atomic hardlink claim.
    // A crash before linkSync leaves only an inert staging file, never an
    // empty lock whose owner cannot be identified after restart.
    const staged = `${lock}.${randomUUID()}.tmp`;
    const fd = openSync(staged, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify({ v: 1, pid: process.pid, token: randomUUID() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    let acquired = false;
    const acquire = (): boolean => {
      try {
        linkSync(staged, lock);
        acquired = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return false;
      }
    };
    try {
      if (!acquire() && (!reclaimDeadLock(lock) || !acquire())) return false;
      syncParent(path);
      return mutate();
    } finally {
      if (acquired) unlinkSync(lock);
      if (existsSync(staged)) unlinkSync(staged);
    }
  }
  function writeState(path: string, sessionId: string, actionId: string,
    state: HoldState['state'], controlledAdmitted = false): string {
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify({ v: 2, sessionId, actionId, state, controlledAdmitted }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return temp;
  }
  function syncParent(path: string): void {
    const fd = openSync(holdsDir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  return {
    status: (sessionId: string): { actionId: string; held: boolean } | null => {
      const state = stateFrom(fileFor(activeServerDir, sessionId));
      return state ? { actionId: state.actionId, held: state.held } : null;
    },
    hold: (sessionId: string, actionId: string): boolean => {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(actionId)) throw new Error('Invalid action id');
      const path = fileFor(activeServerDir, sessionId);
      return withMutationLock(sessionId, () => {
        const current = existsSync(path) ? stateFrom(path) : null;
        if (current?.actionId === actionId) return current.held;
        if (existsSync(path) && (!current || current.held)) return false;
        const temp = writeState(path, sessionId, actionId, 'held');
        try {
          if (current) renameSync(temp, path);
          else linkSync(temp, path);
          syncParent(path);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const observed = stateFrom(path);
          return observed?.actionId === actionId && observed.held;
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
        }
      });
    },
    release: (sessionId: string, actionId: string): boolean => {
      const path = fileFor(activeServerDir, sessionId);
      return withMutationLock(sessionId, () => {
        const current = stateFrom(path);
        if (current?.actionId !== actionId) return false;
        if (!current.held) return true;
        const temp = writeState(path, sessionId, actionId, 'released', current.controlledAdmitted);
        try {
          renameSync(temp, path);
          syncParent(path);
          return true;
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
        }
      });
    },
    reserveControlledAdmit: (sessionId: string, actionId: string): boolean => {
      const path = fileFor(activeServerDir, sessionId);
      return withMutationLock(sessionId, () => {
        const current = stateFrom(path);
        if (!current || current.version !== 2 || current.actionId !== actionId || !current.held) return false;
        if (current.controlledAdmitted) return true;
        const temp = writeState(path, sessionId, actionId, 'held', true);
        try {
          renameSync(temp, path);
          syncParent(path);
          return true;
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
        }
      });
    },
    cancelIfNoControlledTurn: (sessionId: string, actionId: string): boolean => {
      const path = fileFor(activeServerDir, sessionId);
      return withMutationLock(sessionId, () => {
        const current = stateFrom(path);
        if (!current || current.version !== 2 || current.actionId !== actionId) return false;
        if (current.state === 'cancelled') return true;
        if (!current.held || current.controlledAdmitted) return false;
        const temp = writeState(path, sessionId, actionId, 'cancelled');
        try {
          renameSync(temp, path);
          syncParent(path);
          return true;
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
        }
      });
    },
    canControlledWake: (sessionId: string, actionId: string, kind: 'compact' | 'continue'): boolean => {
      const path = fileFor(activeServerDir, sessionId);
      if (existsSync(path.slice(0, -'.json'.length) + '.lock')) return false;
      const current = stateFrom(path);
      return current?.actionId === actionId && current.state === 'released'
        && (kind !== 'compact' || current.controlledAdmitted);
    },
    isHeld: (sessionId: string): boolean => {
      const path = fileFor(activeServerDir, sessionId);
      if (existsSync(path.slice(0, -'.json'.length) + '.lock')) return true;
      if (!existsSync(path)) return false;
      return stateFrom(path)?.held !== false;
    },
  };
}
