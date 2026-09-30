import { readFileSync } from 'node:fs';

import type { TrackedSession } from '@/daemon/types';

/**
 * Reads the process-group id of a pid from `/proc/<pid>/stat` (field 5). Returns null when it
 * cannot be determined (non-Linux, process gone, unparsable).
 */
export function readProcessGroupIdFromProc(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) is parenthesised and may contain spaces; parse after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number.parseInt(rest[2] ?? '', 10);
    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
  } catch {
    return null;
  }
}

/**
 * Process group to signal when restarting a daemon-spawned session runner, so the runner's own
 * provider child (e.g. the Claude process) goes down with it instead of being orphaned.
 *
 * A session that was re-attached after a daemon restart has no `childProcess` handle, but its runner
 * is still the leader of the detached group it was spawned into. Signal the group in that case only
 * when the leadership is verified (pgid === pid), so an unrelated group is never targeted.
 */
export function resolveConnectedServiceRestartProcessGroupPid(
  tracked: TrackedSession,
  deps: Readonly<{ readProcessGroupId?: (pid: number) => number | null }> = {},
): number | null {
  if (tracked.startedBy !== 'daemon' || !Number.isInteger(tracked.pid) || tracked.pid <= 0) return null;
  if (tracked.childProcess) return tracked.pid;
  const pgid = (deps.readProcessGroupId ?? readProcessGroupIdFromProc)(tracked.pid);
  return pgid === tracked.pid ? tracked.pid : null;
}
