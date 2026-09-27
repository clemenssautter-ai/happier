import { describe, expect, it, vi } from 'vitest';

import { preflightConnectedServiceProfile } from './preflightConnectedServiceProfile';

describe('connected Claude profile preflight', () => {
  it('uses an authoritative fresh profile-health list and rejects missing or reconnect-required targets', async () => {
    const listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'claude-subscription',
      profiles: [
        { profileId: 'clemens2', status: 'connected' as const },
        { profileId: 'johanna', status: 'needs_reauth' as const },
      ],
    }));
    const read = (profileId: string) => preflightConnectedServiceProfile({
      profileId, listConnectedServiceProfiles,
    });
    expect((await read('clemens2')).usable).toBe(true);
    expect((await read('johanna')).usable).toBe(false);
    expect((await read('missing')).usable).toBe(false);
    expect(listConnectedServiceProfiles).toHaveBeenCalledWith({
      serviceId: 'claude-subscription', forceRefresh: true,
    });
  });
});
