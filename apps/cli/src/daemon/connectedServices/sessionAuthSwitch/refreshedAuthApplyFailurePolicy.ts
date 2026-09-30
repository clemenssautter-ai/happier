/**
 * Apply failures of a refreshed credential for ONE session that must not fail the whole refresh
 * notification (and with it the change sync that delivers it). The session keeps running on its
 * current runtime and picks the refreshed credentials up on its next start:
 * - `restart_disallowed_by_execution_policy`: a restart is not allowed for this switch.
 * - `hot_apply_restart_required`: the credential cannot be applied in place (e.g. a single-profile
 *   binding) and only a restart would apply it; refresh-driven restarts are handled separately.
 */
const SESSION_LOCAL_REFRESH_APPLY_FAILURE_CODES: ReadonlySet<string> = new Set([
  'restart_disallowed_by_execution_policy',
  'hot_apply_restart_required',
]);

export function isSessionLocalRefreshApplyFailure(errorCode: string | undefined | null): boolean {
  return typeof errorCode === 'string' && SESSION_LOCAL_REFRESH_APPLY_FAILURE_CODES.has(errorCode);
}
