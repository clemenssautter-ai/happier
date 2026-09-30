import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '@/daemon/types';

import {
  readProcessGroupIdFromProc,
  resolveConnectedServiceRestartProcessGroupPid,
} from './resolveConnectedServiceRestartProcessGroupPid';

function tracked(overrides: Partial<TrackedSession>): TrackedSession {
  return { startedBy: 'daemon', pid: 4242, ...overrides } as TrackedSession;
}

describe('resolveConnectedServiceRestartProcessGroupPid', () => {
  it('uses the runner group for a daemon-spawned session with a live child handle', () => {
    const readProcessGroupId = () => { throw new Error('must not be consulted'); };
    expect(resolveConnectedServiceRestartProcessGroupPid(
      tracked({ childProcess: {} as TrackedSession['childProcess'] }),
      { readProcessGroupId },
    )).toBe(4242);
  });

  it('uses the group of a re-attached runner (no child handle) when it leads its own group', () => {
    expect(resolveConnectedServiceRestartProcessGroupPid(tracked({}), { readProcessGroupId: () => 4242 })).toBe(4242);
  });

  it('never targets a group the re-attached runner does not lead', () => {
    expect(resolveConnectedServiceRestartProcessGroupPid(tracked({}), { readProcessGroupId: () => 99 })).toBeNull();
    expect(resolveConnectedServiceRestartProcessGroupPid(tracked({}), { readProcessGroupId: () => null })).toBeNull();
  });

  it('never targets a group for sessions the daemon did not start', () => {
    expect(resolveConnectedServiceRestartProcessGroupPid(
      tracked({ startedBy: 'terminal' as TrackedSession['startedBy'] }),
      { readProcessGroupId: () => 4242 },
    )).toBeNull();
  });

  it('reads the real process group of this process from /proc', () => {
    if (process.platform !== 'linux') return;
    const pgid = readProcessGroupIdFromProc(process.pid);
    expect(pgid).not.toBeNull();
    expect(pgid).toBeGreaterThan(0);
    expect(readProcessGroupIdFromProc(2 ** 31 - 2)).toBeNull();
  });
});
