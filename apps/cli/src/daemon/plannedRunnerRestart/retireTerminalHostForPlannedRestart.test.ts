import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter, TerminalHostHandle, TerminalAttachmentId } from '@/integrations/terminalHost/_types';
import type { BoundTerminalAttachmentInfo, TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { TrackedSession } from '@/daemon/types';
import { requestConnectedServiceSessionRestartSignal } from '@/daemon/connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';

import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';
import { createPlannedRestartTerminalHostRetirement } from './retireTerminalHostForPlannedRestart';

const ATTACHMENT_ID = 'attach-1' as TerminalAttachmentId;

function boundAttachment(sessionId: string): BoundTerminalAttachmentInfo {
  const handle = {
    attachmentId: ATTACHMENT_ID,
    kind: 'tmux',
    sessionName: 'happier-claude-unified-test',
    paneId: '%1',
    attachMetadata: { attachStrategy: 'terminal_host', topology: 'exclusive', locality: 'same_machine', liveProbe: 'required' },
  } as unknown as TerminalHostHandle & { attachmentId: TerminalAttachmentId };
  return {
    version: 2,
    attachmentId: ATTACHMENT_ID,
    sessionId,
    handle,
    terminal: { mode: 'tmux' } as BoundTerminalAttachmentInfo['terminal'],
    updatedAt: 1,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

const spawned: ChildProcess[] = [];
function spawnSleeper(): ChildProcess {
  // detached: own session and process group, like the runner and the tmux host in production.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  spawned.push(child);
  return child;
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  }
});

function fakeAdapter(input: { hostPid: number; disposeKills: boolean }): TerminalHostAdapter {
  return {
    kind: 'tmux',
    dispose: vi.fn(async () => {
      if (!input.disposeKills) throw new Error('kill-server suppressed');
      process.kill(-input.hostPid, 'SIGKILL');
    }),
    evaluateLiveness: vi.fn(async () => ({ paneAlive: isAlive(input.hostPid), observedAt: Date.now() })),
  } as unknown as TerminalHostAdapter;
}

function memoryAttachmentStore(initial: TerminalAttachmentInfo | null) {
  let current = initial;
  return {
    read: vi.fn(async () => current),
    remove: vi.fn(async () => {
      current = null;
      return true;
    }),
    get: () => current,
  };
}

describe('planned restart terminal host retirement', () => {
  it('reports none when the session has no bound terminal host', async () => {
    for (const info of [null, { version: 1, sessionId: 's', terminal: { mode: 'tmux' }, updatedAt: 1 } as TerminalAttachmentInfo]) {
      const store = memoryAttachmentStore(info);
      const loadTerminalHostAdapters = vi.fn(async () => ({}));
      const retire = createPlannedRestartTerminalHostRetirement({
        happyHomeDir: '/unused',
        loadTerminalHostAdapters,
        readAttachmentInfo: store.read,
        removeAttachmentInfo: store.remove,
      });
      await expect(retire({ sessionId: 's' })).resolves.toEqual({ status: 'none' });
      expect(loadTerminalHostAdapters).not.toHaveBeenCalled();
    }
  });

  it('fails closed when no adapter can dispose the recorded host kind', async () => {
    const store = memoryAttachmentStore(boundAttachment('s'));
    const retire = createPlannedRestartTerminalHostRetirement({
      happyHomeDir: '/unused',
      loadTerminalHostAdapters: async () => ({}),
      readAttachmentInfo: store.read,
      removeAttachmentInfo: store.remove,
    });
    await expect(retire({ sessionId: 's' })).resolves.toEqual({ status: 'failed', reason: 'terminal_host_adapter_unavailable' });
  });

  it('a detached host survives the runner group signal, and is gone after a planned switch restart', async () => {
    const runner = spawnSleeper();
    const host = spawnSleeper();
    expect(await waitUntil(() => isAlive(runner.pid!) && isAlive(host.pid!))).toBe(true);

    const store = memoryAttachmentStore(boundAttachment('s'));
    const adapter = fakeAdapter({ hostPid: host.pid!, disposeKills: true });
    const tracked = { startedBy: 'daemon', pid: runner.pid!, happySessionId: 's' } as TrackedSession;
    const retire = createPlannedRestartTerminalHostRetirement({
      happyHomeDir: '/unused',
      loadTerminalHostAdapters: async () => ({ tmux: adapter }),
      readAttachmentInfo: store.read,
      removeAttachmentInfo: store.remove,
    });

    const result = await requestPlannedRunnerRestart({
      sessionId: 's',
      tracked,
      reason: 'connected_service_switch',
      deferral: { kind: 'none' },
      restartRequestedPids: new Set(),
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      retireTerminalHost: retire,
      isProcessSafeToSignal: async () => true,
      requestSignal: async ({ shouldSignal, onSignalFailure, onProcessAlreadyMissing }) =>
        await requestConnectedServiceSessionRestartSignal({
          pid: tracked.pid,
          processGroupPid: tracked.pid,
          delayMs: 0,
          shouldSignal,
          onSignalFailure,
          onProcessAlreadyMissing,
        }),
      logDebug: () => {},
      logWarn: () => {},
    });

    expect(result).toEqual({ signaled: true });
    expect(await waitUntil(() => !isAlive(runner.pid!) && !isAlive(host.pid!))).toBe(true);
    expect(store.get()).toBeNull();
  });

  it('keeps the runner alive and reports no signal when the host kill is suppressed', async () => {
    const runner = spawnSleeper();
    const host = spawnSleeper();
    expect(await waitUntil(() => isAlive(runner.pid!) && isAlive(host.pid!))).toBe(true);

    const store = memoryAttachmentStore(boundAttachment('s'));
    const adapter = fakeAdapter({ hostPid: host.pid!, disposeKills: false });
    const tracked = { startedBy: 'daemon', pid: runner.pid!, happySessionId: 's' } as TrackedSession;
    const retire = createPlannedRestartTerminalHostRetirement({
      happyHomeDir: '/unused',
      loadTerminalHostAdapters: async () => ({ tmux: adapter }),
      readAttachmentInfo: store.read,
      removeAttachmentInfo: store.remove,
      logWarn: () => {},
    });
    const requestSignal = vi.fn(async ({ shouldSignal }: { shouldSignal: () => Promise<boolean> | boolean }) => {
      if (!await shouldSignal()) return { status: 'skipped_stale_owner' as const };
      process.kill(-tracked.pid, 'SIGTERM');
      return { status: 'requested' as const };
    });

    const result = await requestPlannedRunnerRestart({
      sessionId: 's',
      tracked,
      reason: 'connected_service_switch',
      deferral: { kind: 'none' },
      restartRequestedPids: new Set(),
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      retireTerminalHost: retire,
      isProcessSafeToSignal: async () => true,
      requestSignal,
      logDebug: () => {},
      logWarn: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'terminal_host_not_retired' });
    expect(isAlive(runner.pid!)).toBe(true);
    expect(isAlive(host.pid!)).toBe(true);
    expect(store.get()).not.toBeNull();
  });

  it('control: without retirement the detached host outlives the runner group signal', async () => {
    const runner = spawnSleeper();
    const host = spawnSleeper();
    expect(await waitUntil(() => isAlive(runner.pid!) && isAlive(host.pid!))).toBe(true);
    process.kill(-runner.pid!, 'SIGTERM');
    expect(await waitUntil(() => !isAlive(runner.pid!))).toBe(true);
    expect(isAlive(host.pid!)).toBe(true);
  });
});
