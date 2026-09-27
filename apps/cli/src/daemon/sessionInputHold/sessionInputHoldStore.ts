import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';

function fileFor(activeServerDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) {
    throw new Error('Invalid session input hold target');
  }
  return join(activeServerDir, 'session-input-holds', `${sessionId}.json`);
}

function stateFrom(path: string): { actionId: string; held: boolean } | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const actionId = (value as { actionId?: unknown }).actionId;
    if (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(actionId)) return null;
    return { actionId, held: (value as { state?: unknown }).state !== 'released' };
  } catch {
    return null;
  }
}

export function createSessionInputHoldStore(activeServerDir: string) {
  const holdsDir = join(activeServerDir, 'session-input-holds');
  function withMutationLock(sessionId: string, mutate: () => boolean): boolean {
    const path = fileFor(activeServerDir, sessionId);
    const lock = path.slice(0, -'.json'.length) + '.lock';
    mkdirSync(holdsDir, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    try {
      return mutate();
    } finally {
      rmdirSync(lock);
    }
  }
  function writeState(path: string, sessionId: string, actionId: string, state: 'held' | 'released'): string {
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify({ v: 1, sessionId, actionId, state }));
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
    status: (sessionId: string): { actionId: string; held: boolean } | null =>
      stateFrom(fileFor(activeServerDir, sessionId)),
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
        const temp = writeState(path, sessionId, actionId, 'released');
        try {
          renameSync(temp, path);
          syncParent(path);
          return true;
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
        }
      });
    },
    isHeld: (sessionId: string): boolean => {
      const path = fileFor(activeServerDir, sessionId);
      if (existsSync(path.slice(0, -'.json'.length) + '.lock')) return true;
      if (!existsSync(path)) return false;
      return stateFrom(path)?.held !== false;
    },
  };
}
