/** Stable generation for both an initial profile choice and later switches. */
export function resolveBindingGeneration(
  connectedServicesUpdatedAt: unknown,
  sessionCreatedAt: unknown,
): number | null {
  if (typeof connectedServicesUpdatedAt === 'number'
      && Number.isSafeInteger(connectedServicesUpdatedAt) && connectedServicesUpdatedAt > 0) {
    return connectedServicesUpdatedAt;
  }
  if (typeof sessionCreatedAt === 'number'
      && Number.isSafeInteger(sessionCreatedAt) && sessionCreatedAt > 0) {
    return sessionCreatedAt;
  }
  return null;
}
