import type { TerminalHostRegistry } from '@/integrations/terminalHost/registry';
import {
  readTerminalAttachmentInfo,
  removeTerminalAttachmentInfo,
  type BoundTerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';

import type {
  PlannedRunnerRestartTerminalHostRetirement,
  PlannedRunnerRestartTerminalHostRetirementResult,
} from './types';

/**
 * Daemon-side counterpart of the runner's explicit-stop host disposal: the same exact-identity
 * disposition (`executeTerminalHostDisposition` / destroy_owned_host), driven from the daemon so it
 * works even though the runner is about to be signalled and cannot do it itself.
 *
 * Only bound (version 2) attachments describe a detached host that outlives its runner. A legacy
 * attachment describes a runner living inside the user's own terminal; that terminal goes away with
 * the runner signal and must never be destroyed here.
 */
export function createPlannedRestartTerminalHostRetirement(deps: Readonly<{
  happyHomeDir: string;
  loadTerminalHostAdapters: () => Promise<TerminalHostRegistry | null>;
  readAttachmentInfo?: typeof readTerminalAttachmentInfo;
  removeAttachmentInfo?: typeof removeTerminalAttachmentInfo;
  /** Same hook the explicit stop uses to retire control serviceability before the descriptor goes. */
  retireExactTerminalControlServiceability?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<unknown>;
  /** Same hook the explicit stop uses to clean provider artifacts after the exact host is gone. */
  onExactTerminalAttachmentRetired?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<void>;
  logWarn?: (message: string, payload?: unknown) => void;
}>): PlannedRunnerRestartTerminalHostRetirement {
  const failed = (reason: string): PlannedRunnerRestartTerminalHostRetirementResult => ({ status: 'failed', reason });

  return async ({ sessionId }) => {
    // Resolved per call, not at construction: the daemon builds this at startup, and construction
    // must not touch attachment-store bindings that only a restart actually needs.
    const readAttachmentInfo = deps.readAttachmentInfo ?? readTerminalAttachmentInfo;
    const removeAttachmentInfo = deps.removeAttachmentInfo ?? removeTerminalAttachmentInfo;
    let attachmentInfo;
    try {
      attachmentInfo = await readAttachmentInfo({ happyHomeDir: deps.happyHomeDir, sessionId });
    } catch (error) {
      deps.logWarn?.('[DAEMON RUN] Cannot read terminal attachment before planned runner restart', { sessionId, error });
      return failed('attachment_unreadable');
    }
    if (!attachmentInfo || attachmentInfo.version !== 2) return { status: 'none' };

    const adapters = await deps.loadTerminalHostAdapters().catch(() => null);
    const adapter = adapters?.[attachmentInfo.handle.kind];
    if (!adapter) return failed('terminal_host_adapter_unavailable');

    const disposition = await executeTerminalHostDisposition({
      happyHomeDir: deps.happyHomeDir,
      sessionId,
      expectedAttachmentId: attachmentInfo.attachmentId,
      intent: { kind: 'destroy_owned_host', reason: 'planned_runner_restart' },
      adapter,
      readAttachmentInfo,
      removeAttachmentInfo,
      ...(deps.retireExactTerminalControlServiceability
        ? {
            beforeDescriptorRetirement: async ({ attachmentInfo: current }) => {
              await deps.retireExactTerminalControlServiceability!({
                happyHomeDir: deps.happyHomeDir,
                sessionId,
                attachmentInfo: current,
              });
            },
          }
        : {}),
    }).catch((error) => {
      deps.logWarn?.('[DAEMON RUN] Terminal host disposition threw before planned runner restart', { sessionId, error });
      return { status: 'parked', reason: 'destroy_failed' } as const;
    });

    if (disposition.status === 'destroyed') {
      if (disposition.retirementFailed) return failed('terminal_control_serviceability_retirement_failed');
      if (disposition.descriptorRetained) return failed('terminal_attachment_descriptor_retirement_failed');
      await deps.onExactTerminalAttachmentRetired?.({
        happyHomeDir: deps.happyHomeDir,
        sessionId,
        attachmentInfo,
      }).catch((error) => {
        deps.logWarn?.('[DAEMON RUN] Terminal host retired but provider artifacts could not be cleaned', { sessionId, error });
      });
      return { status: 'destroyed' };
    }
    return failed(disposition.status === 'parked' ? disposition.reason : disposition.status);
  };
}
