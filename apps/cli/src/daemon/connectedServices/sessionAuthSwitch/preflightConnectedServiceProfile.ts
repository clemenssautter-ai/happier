import {
  isConnectedServiceCredentialHealthStatusUsable,
  type ConnectedServiceCredentialHealthStatusV1,
} from '@happier-dev/protocol';

/** Read the existing server profile-health truth without changing a session or credential. */
export async function preflightConnectedServiceProfile(input: Readonly<{
  profileId: string;
  listConnectedServiceProfiles: (params: Readonly<{
    serviceId: 'claude-subscription'; forceRefresh: true;
  }>) => Promise<Readonly<{
    serviceId: string;
    profiles: readonly Readonly<{
      profileId: string; status: ConnectedServiceCredentialHealthStatusV1;
    }>[];
  }>>;
}>): Promise<Readonly<{
  serviceId: 'claude-subscription'; profileId: string; observedAt: number; usable: boolean;
}>> {
  const serviceId = 'claude-subscription';
  const inventory = await input.listConnectedServiceProfiles({ serviceId, forceRefresh: true });
  if (inventory.serviceId !== serviceId) throw new Error('profile preflight service mismatch');
  const matches = inventory.profiles.filter((profile) => profile.profileId === input.profileId);
  return {
    serviceId, profileId: input.profileId, observedAt: Date.now(),
    usable: matches.length === 1 && isConnectedServiceCredentialHealthStatusUsable(matches[0].status),
  };
}
