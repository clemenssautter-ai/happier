import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { ConnectedServiceSwitchDeferralConflictError } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';

import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'claude-thread-1',
    } satisfies SpawnSessionOptions,
    ...overrides,
  };
}

const retireNone = async () => ({ status: 'none' as const });

describe('requestPlannedRunnerRestart', () => {
  it('routes connected-service restarts through deferral before reserving and signalling the runner', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const requestSwitch = vi.fn(async (input: { runSwitch: () => Promise<void> }) => {
      expect(restartRequestedPids.has(tracked.pid)).toBe(false);
      await input.runSwitch();
    });
    const requestSignal = vi.fn(async () => {
      expect(restartRequestedPids.has(tracked.pid)).toBe(true);
      return { status: 'requested' as const };
    });

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'connected_service_switch',
      deferral: {
        kind: 'connected_service_switch',
        source: 'automatic',
        policy: 'defer_until_turn_boundary',
        target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 },
        turnDeferralQueue: { requestSwitch },
      },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      retireTerminalHost: retireNone,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: true });
    expect(requestSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      source: 'automatic',
      policy: 'defer_until_turn_boundary',
      target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 },
    }));
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('clears the reservation and reports no signal when ownership changes before signal', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      retireTerminalHost: retireNone,
      requestSignal: async ({ shouldSignal }) => {
        pidToTrackedSession.delete(tracked.pid);
        return shouldSignal() ? { status: 'requested' as const } : { status: 'skipped_stale_owner' as const };
      },
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'stale_owner' });
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('clears the reservation and reports no signal when pid identity is unsafe', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const isProcessSafeToSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async ({ shouldSignal }) => (
      await shouldSignal()
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const }
    ));

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      retireTerminalHost: retireNone,
      isProcessSafeToSignal,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'unsafe_process' });
    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: 4242,
      expectedProcessCommandHash: 'hash-1',
    });
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('clears the reservation and reports no signal when activity starts before signal', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const canSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async ({ shouldSignal }) => (
      await shouldSignal()
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const }
    ));

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      retireTerminalHost: retireNone,
      canSignal,
      isProcessSafeToSignal: async () => true,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'activity_in_progress' });
    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('preserves the exact activity disabled reason when the final signal guard rejects', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const canSignal = vi.fn(async () => 'approval_pending' as const);
    const requestSignal = vi.fn(async ({ shouldSignal }) => (
      await shouldSignal()
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const }
    ));

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      retireTerminalHost: retireNone,
      canSignal,
      isProcessSafeToSignal: async () => true,
      logDebug: () => {},
    });

    expect(result).toEqual({
      signaled: false,
      notSignaledReason: 'activity_in_progress',
      activityDisabledReason: 'approval_pending',
    });
    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('observes missing processes through the caller hook and keeps the forced-respawn reservation', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const observeProcessMissing = vi.fn();

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal: async () => ({ status: 'process_already_missing' as const }),
      retireTerminalHost: retireNone,
      observeProcessMissing,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: true });
    expect(observeProcessMissing).toHaveBeenCalledWith(tracked);
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('preserves connected-service cancellation semantics when a deferred request is superseded', async () => {
    const tracked = trackedSession();
    const restartRequestedPids = new Set<number>();
    const requestSignal = vi.fn(async () => ({ status: 'requested' as const }));

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'connected_service_switch',
      deferral: {
        kind: 'connected_service_switch',
        source: 'automatic',
        policy: 'defer_until_turn_boundary',
        target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 },
        turnDeferralQueue: {
          requestSwitch: async () => {
            throw new ConnectedServiceSwitchDeferralConflictError({
              code: 'switch_cancelled',
              message: 'superseded',
            });
          },
        },
      },
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
      retireTerminalHost: retireNone,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'superseded' });
    expect(requestSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
  });

  describe('terminal host retirement', () => {
    const runRestart = async (input: {
      reason: 'connected_service_switch' | 'version_runtime_refresh';
      retireTerminalHost: (input: { sessionId: string }) => Promise<
        { status: 'none' } | { status: 'destroyed' } | { status: 'failed'; reason: string }
      >;
      events: string[];
    }) => {
      const tracked = trackedSession();
      const restartRequestedPids = new Set<number>();
      const result = await requestPlannedRunnerRestart({
        sessionId: 'sess-1',
        tracked,
        reason: input.reason,
        deferral: { kind: 'none' },
        restartRequestedPids,
        pidToTrackedSession: new Map([[tracked.pid, tracked]]),
        retireTerminalHost: input.retireTerminalHost,
        requestSignal: async ({ shouldSignal }) => {
          if (!await shouldSignal()) return { status: 'skipped_stale_owner' as const };
          input.events.push('signal');
          return { status: 'requested' as const };
        },
        isProcessSafeToSignal: async () => true,
        logDebug: () => {},
        logWarn: () => {},
      });
      return { result, restartRequestedPids, tracked };
    };

    it('retires the terminal host before the runner signal for a connected-service switch', async () => {
      const events: string[] = [];
      const { result } = await runRestart({
        reason: 'connected_service_switch',
        events,
        retireTerminalHost: async ({ sessionId }) => {
          events.push(`retire:${sessionId}`);
          return { status: 'destroyed' };
        },
      });
      expect(result).toEqual({ signaled: true });
      expect(events).toEqual(['retire:sess-1', 'signal']);
    });

    it('does not signal the runner when the terminal host cannot be proven retired', async () => {
      const events: string[] = [];
      const { result, restartRequestedPids, tracked } = await runRestart({
        reason: 'connected_service_switch',
        events,
        retireTerminalHost: async () => ({ status: 'failed', reason: 'destroy_failed' }),
      });
      expect(result).toEqual({ signaled: false, notSignaledReason: 'terminal_host_not_retired' });
      expect(events).toEqual([]);
      expect(restartRequestedPids.has(tracked.pid)).toBe(false);
    });

    it('keeps the terminal host for a version runtime refresh', async () => {
      const events: string[] = [];
      const retire = vi.fn(async () => ({ status: 'destroyed' as const }));
      const { result } = await runRestart({ reason: 'version_runtime_refresh', events, retireTerminalHost: retire });
      expect(result).toEqual({ signaled: true });
      expect(retire).not.toHaveBeenCalled();
      expect(events).toEqual(['signal']);
    });
  });
});
