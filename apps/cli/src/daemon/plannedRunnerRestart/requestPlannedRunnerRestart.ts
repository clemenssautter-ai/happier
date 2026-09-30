import type { TrackedSession } from '@/daemon/types';
import { ConnectedServiceSwitchDeferralConflictError } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { isPidSafeHappySessionProcess } from '@/daemon/pidSafety';
import {
  SESSION_RUNNER_RESTART_DISABLED_REASONS,
  type SessionRunnerRestartDisabledReason,
} from '@happier-dev/protocol';

import type {
  PlannedRunnerRestartDeferral,
  PlannedRunnerRestartNotSignaledReason,
  PlannedRunnerRestartReason,
  PlannedRunnerRestartSignalActivityGateResult,
  PlannedRunnerRestartSignalRequest,
  PlannedRunnerRestartSignalResult,
  PlannedRunnerRestartTerminalHostRetirement,
} from './types';

async function runWithDeferral(input: Readonly<{
  sessionId: string;
  deferral: PlannedRunnerRestartDeferral;
  runSwitch: () => Promise<void>;
}>): Promise<void> {
  if (input.deferral.kind === 'none') {
    await input.runSwitch();
    return;
  }
  await input.deferral.turnDeferralQueue.requestSwitch({
    sessionId: input.sessionId,
    source: input.deferral.source,
    policy: input.deferral.policy,
    target: input.deferral.target,
    runSwitch: input.runSwitch,
  });
}

/**
 * Whether the runtime process must NOT survive the restart, so the detached terminal host that
 * carries it is retired together with the runner.
 *
 * A connected-service switch changes the runtime's credentials/config directory. A detached host
 * (Claude Unified tmux) outlives the runner signal and would be re-adopted by the next runner with the
 * OLD config, so the switch would silently never take effect. A runtime refresh, in contrast, wants
 * the runtime to keep running. The Record type forces every new reason to decide this explicitly.
 */
const RESTART_RETIRES_TERMINAL_HOST: Readonly<Record<PlannedRunnerRestartReason, boolean>> = {
  connected_service_switch: true,
  temporary_throttle_recovery: false,
  version_runtime_refresh: false,
};

const RESTART_DISABLED_REASON_SET = new Set<string>(SESSION_RUNNER_RESTART_DISABLED_REASONS);

function normalizeActivityDisabledReason(
  value: PlannedRunnerRestartSignalActivityGateResult,
): SessionRunnerRestartDisabledReason | null {
  return typeof value === 'string' && RESTART_DISABLED_REASON_SET.has(value) ? value : null;
}

export async function requestPlannedRunnerRestart(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  reason: PlannedRunnerRestartReason;
  deferral: PlannedRunnerRestartDeferral;
  restartRequestedPids: Set<number>;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  requestSignal: (request: PlannedRunnerRestartSignalRequest) => Promise<PlannedRunnerRestartSignalResult>;
  /**
   * Required on purpose: retiring the detached terminal host is part of the restart, not an opt-in
   * of the caller. Applied only for reasons that change the runtime's identity (see
   * RESTART_RETIRES_TERMINAL_HOST).
   */
  retireTerminalHost: PlannedRunnerRestartTerminalHostRetirement;
  canSignal?: () => PlannedRunnerRestartSignalActivityGateResult | Promise<PlannedRunnerRestartSignalActivityGateResult>;
  isProcessSafeToSignal?: (params: Readonly<{
    pid: number;
    expectedProcessCommandHash?: string;
    expectedProcessInstanceFingerprint?: string;
  }>) => Promise<boolean>;
  observeProcessMissing?: (tracked: TrackedSession) => void;
  clearRestartIntentForPid?: (pid: number) => void;
  onSignalFailureLogMessage?: string;
  logDebug: (message: string, payload?: unknown) => void;
  logWarn?: (message: string, payload?: unknown) => void;
}>): Promise<Readonly<{
  signaled: boolean;
  notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
  activityDisabledReason?: SessionRunnerRestartDisabledReason;
}>> {
  let signaled = false;
  let notSignaledReason: PlannedRunnerRestartNotSignaledReason | undefined;
  let activityDisabledReason: SessionRunnerRestartDisabledReason | undefined;
  const isProcessSafeToSignal = input.isProcessSafeToSignal ?? isPidSafeHappySessionProcess;
  try {
    await runWithDeferral({
      sessionId: input.sessionId,
      runSwitch: async () => {
        input.restartRequestedPids.add(input.tracked.pid);
        let ownerStillCurrent = true;
        let missingProcessObserved = false;

        const signalResult = await input.requestSignal({
          tracked: input.tracked,
          shouldSignal: async () => {
            ownerStillCurrent = input.pidToTrackedSession.get(input.tracked.pid) === input.tracked;
            if (!ownerStillCurrent) {
              notSignaledReason = 'stale_owner';
              return false;
            }
            const safe = await isProcessSafeToSignal({
              pid: input.tracked.pid,
              ...(input.tracked.processCommandHash
                ? { expectedProcessCommandHash: input.tracked.processCommandHash }
                : {}),
              ...(input.tracked.processInstanceFingerprint
                ? { expectedProcessInstanceFingerprint: input.tracked.processInstanceFingerprint }
                : {}),
            });
            if (!safe) {
              notSignaledReason = 'unsafe_process';
              return false;
            }
            const activityGateResult = await input.canSignal?.();
            const exactActivityDisabledReason = normalizeActivityDisabledReason(activityGateResult);
            if (exactActivityDisabledReason || activityGateResult === false) {
              notSignaledReason = 'activity_in_progress';
              activityDisabledReason = exactActivityDisabledReason ?? undefined;
              return false;
            }
            if (RESTART_RETIRES_TERMINAL_HOST[input.reason]) {
              // Last guard before the signal: the host is destroyed only when the runner is really
              // about to be signalled. A host that cannot be proven gone vetoes the signal, so the
              // caller sees a failed restart instead of a restart that leaves the old runtime alive.
              const retirement = await input.retireTerminalHost({ sessionId: input.sessionId });
              if (retirement.status === 'failed') {
                notSignaledReason = 'terminal_host_not_retired';
                input.logWarn?.('[DAEMON RUN] Planned runner restart aborted: terminal host could not be retired', {
                  sessionId: input.sessionId,
                  reason: input.reason,
                  failure: retirement.reason,
                });
                return false;
              }
              if (retirement.status === 'destroyed') {
                input.logDebug('[DAEMON RUN] Retired terminal host before planned runner restart', {
                  sessionId: input.sessionId,
                  reason: input.reason,
                });
              }
            }
            return true;
          },
          onSignalFailure: (error) => {
            input.restartRequestedPids.delete(input.tracked.pid);
            input.clearRestartIntentForPid?.(input.tracked.pid);
            if (input.onSignalFailureLogMessage) {
              input.logWarn?.(input.onSignalFailureLogMessage, error);
            }
          },
          onProcessAlreadyMissing: () => {
            missingProcessObserved = true;
            input.observeProcessMissing?.(input.tracked);
          },
        });

        if (signalResult.status === 'skipped_duplicate_restart') {
          notSignaledReason = 'duplicate_restart';
        }
        if (signalResult.status === 'skipped_terminal_restart') {
          notSignaledReason = 'terminal_restart';
        }
        if (
          !ownerStillCurrent
          || signalResult.status === 'skipped_stale_owner'
          || signalResult.status === 'skipped_duplicate_restart'
          || signalResult.status === 'skipped_terminal_restart'
        ) {
          input.restartRequestedPids.delete(input.tracked.pid);
          input.clearRestartIntentForPid?.(input.tracked.pid);
          if (notSignaledReason === 'unsafe_process') {
            input.logWarn?.('[DAEMON RUN] Refusing planned session runner restart because PID identity no longer matches tracked runner', {
              sessionId: input.sessionId,
              pid: input.tracked.pid,
              reason: input.reason,
            });
          }
          return;
        }
        if (signalResult.status === 'process_already_missing' && !missingProcessObserved) {
          input.observeProcessMissing?.(input.tracked);
        }
        signaled = true;
      },
      deferral: input.deferral,
    });
  } catch (error) {
    if (
      input.deferral.kind === 'connected_service_switch' &&
      error instanceof ConnectedServiceSwitchDeferralConflictError &&
      error.code === 'switch_cancelled'
    ) {
        input.logDebug('[DAEMON RUN] Planned runner restart superseded by a newer deferred request', {
        sessionId: input.sessionId,
        reason: input.reason,
        source: input.deferral.source,
      });
      return { signaled: false, notSignaledReason: 'superseded' };
    }
    throw error;
  }

  if (signaled || !notSignaledReason) return { signaled };
  return {
    signaled,
    notSignaledReason,
    ...(activityDisabledReason ? { activityDisabledReason } : {}),
  };
}
