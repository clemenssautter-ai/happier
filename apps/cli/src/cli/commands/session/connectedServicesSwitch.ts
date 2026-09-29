import chalk from 'chalk';

import { readCommandPositionals, readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { requestDaemonSessionConnectedServiceAuthSwitch } from '@/daemon/controlClient';

const KIND = 'session_connected_services_switch';
const DEFAULT_SERVICE_ID = 'claude-subscription';
const DEFAULT_AGENT_ID = 'claude';
const USAGE =
  'Usage: happier session connected-services switch <session-id> --profile <profile-id> [--service <service-id>] [--agent <agent-id>] [--no-restart-resume] [--json]';

/**
 * Switch one session onto a single connected-service profile through the local daemon.
 *
 * Restart-resume is enabled by default for this explicit command: a single-profile session cannot
 * swap accounts in place, so the daemon stores the new binding, waits for the turn boundary and
 * restarts the session. `--no-restart-resume` restores the previous refuse-while-running behaviour.
 */
export async function cmdSessionConnectedServicesSwitch(
  argv: string[],
  deps: Readonly<{
    switchFn?: typeof requestDaemonSessionConnectedServiceAuthSwitch;
  }> = {},
): Promise<void> {
  const json = wantsJson(argv);
  // argv: ['connected-services', 'switch', <session>, ...flags]
  const [sessionId = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--profile', '--service', '--agent'],
  });
  const profileId = readFlagValue(argv, '--profile');
  if (!sessionId || !profileId) throw new Error(USAGE);
  const serviceId = readFlagValue(argv, '--service') ?? DEFAULT_SERVICE_ID;
  const agentId = readFlagValue(argv, '--agent') ?? DEFAULT_AGENT_ID;
  const allowRestartResume = !hasFlag(argv, '--no-restart-resume');

  const switchFn = deps.switchFn ?? requestDaemonSessionConnectedServiceAuthSwitch;
  const result = await switchFn({
    sessionId,
    agentId,
    bindings: {
      v: 1,
      bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'profile', profileId } },
    } as never,
    ...(allowRestartResume ? { applyPolicy: { allowRestartResume: true } } : {}),
  }) as { ok?: boolean; action?: string; errorCode?: string; error?: string; continuityByServiceId?: unknown } | undefined;

  const ok = result?.ok === true;
  if (json) {
    if (ok) {
      await printJsonEnvelope({
        ok: true,
        kind: KIND,
        data: { sessionId, serviceId, profileId, action: result?.action ?? null, continuityByServiceId: result?.continuityByServiceId ?? null },
      });
    } else {
      await printJsonEnvelope({
        ok: false,
        kind: KIND,
        error: { code: result?.errorCode ?? 'switch_failed', ...(result?.error ? { message: result.error } : {}) },
      }, { exitCode: 1 });
    }
    return;
  }
  if (!ok) throw new Error(result?.errorCode ?? 'switch_failed');
  console.log(chalk.green('✓'), `${sessionId}: ${serviceId} -> ${profileId} (${result?.action ?? 'unknown'})`);
}
