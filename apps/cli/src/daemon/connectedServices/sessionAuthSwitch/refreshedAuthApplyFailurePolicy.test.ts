import { describe, expect, it } from 'vitest';

import { isSessionLocalRefreshApplyFailure } from './refreshedAuthApplyFailurePolicy';

describe('isSessionLocalRefreshApplyFailure', () => {
  it('treats restart-only and policy-blocked applies as per-session, non-fatal outcomes', () => {
    expect(isSessionLocalRefreshApplyFailure('hot_apply_restart_required')).toBe(true);
    expect(isSessionLocalRefreshApplyFailure('restart_disallowed_by_execution_policy')).toBe(true);
  });

  it('keeps genuine failures fatal', () => {
    expect(isSessionLocalRefreshApplyFailure('hot_apply_failed')).toBe(false);
    expect(isSessionLocalRefreshApplyFailure('session_not_found')).toBe(false);
    expect(isSessionLocalRefreshApplyFailure(undefined)).toBe(false);
    expect(isSessionLocalRefreshApplyFailure(null)).toBe(false);
  });
});
