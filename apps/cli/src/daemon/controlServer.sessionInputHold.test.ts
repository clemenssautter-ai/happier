import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import { createDaemonControlApp } from './controlServer';
import { createSessionInputHoldStore } from './sessionInputHold/sessionInputHoldStore';

describe('daemon session input hold control', () => {
  it('requires daemon authentication and returns only a fresh target-profile preflight verdict', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error' as const,
                                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                                  errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      handleConnectedServiceProfilePreflight: async ({ serviceId, profileId }) => ({
        serviceId, profileId, observedAt: 123, usable: true,
      }),
    });
    try {
      const payload = { serviceId: 'claude-subscription', profileId: 'clemens2' };
      const denied = await app.inject({ method: 'POST',
        url: '/connected-service-auth/profile/preflight', payload });
      expect(denied.statusCode).toBe(401);
      const accepted = await app.inject({ method: 'POST',
        url: '/connected-service-auth/profile/preflight',
        headers: { 'x-happier-daemon-token': 'token' }, payload });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ ok: true, result: {
        serviceId: 'claude-subscription', profileId: 'clemens2', observedAt: 123, usable: true,
      } });
      const invalid = await app.inject({ method: 'POST',
        url: '/connected-service-auth/profile/preflight',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { serviceId: 'claude-subscription', profileId: '' } });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('fails closed when the target-profile inventory cannot be read', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error' as const,
                                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                                  errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      handleConnectedServiceProfilePreflight: async () => { throw new Error('private upstream body'); },
    });
    try {
      const response = await app.inject({ method: 'POST',
        url: '/connected-service-auth/profile/preflight',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { serviceId: 'claude-subscription', profileId: 'clemens2' } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, errorCode: 'profile_preflight_unavailable' });
    } finally {
      await app.close();
    }
  });

  it('returns an authenticated fresh binding snapshot instead of echoing switch input', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error' as const,
                                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                                  errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      handleSessionBindingSnapshot: async (sessionId) => ({
        sessionId, observedAt: 10, serverUpdatedAt: 9,
        binding: { kind: 'profile', profileId: 'johanna', updatedAt: 8 },
        claudeSessionId: 'claude-1', active: false, activeTurnId: null,
        runtimeKnown: false, serverMessageSeq: 0, pendingCount: 0,
        pendingLocalIds: [], runtime: null,
      }),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/session-binding/read',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: 'session-a' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, result: {
        sessionId: 'session-a', binding: { kind: 'profile', profileId: 'johanna' },
      } });
    } finally {
      await app.close();
    }
  });

  it('preserves controlled switch action identity in the authenticated evidence response', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error' as const,
                                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                                  errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      handleSessionEvidenceRead: async (sessionId, afterSeq) => ({
        sessionId, afterSeq, serverMessageSeq: 17, pendingLocalIds: [],
        rows: [{ seq: 17, kind: 'switch_event', toProfileId: 'clemens2',
                 actionId: 'action_1234' }],
      }),
    });
    try {
      const payload = { sessionId: 'session_1234', afterSeq: 16 };
      const denied = await app.inject({ method: 'POST', url: '/session-input/evidence/read', payload });
      expect(denied.statusCode).toBe(401);
      const accepted = await app.inject({ method: 'POST', url: '/session-input/evidence/read',
        headers: { 'x-happier-daemon-token': 'token' }, payload });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ ok: true, result: {
        sessionId: 'session_1234', afterSeq: 16, serverMessageSeq: 17, pendingLocalIds: [],
        rows: [{ seq: 17, kind: 'switch_event', toProfileId: 'clemens2',
                 actionId: 'action_1234' }],
      } });
    } finally {
      await app.close();
    }
  });

  it('authenticates an exact hold, keeps it durable, and releases only its action', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-usage-control-'));
    const store = createSessionInputHoldStore(dir);
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error' as const,
                                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                                  errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      handleSessionInputHold: ({ sessionId, actionId, operation }) => {
        if (operation === 'status') {
          const state = store.status(sessionId);
          return { ok: state?.actionId === actionId, held: state?.held === true };
        }
        if (operation === 'hold') return { ok: store.hold(sessionId, actionId), held: store.isHeld(sessionId) };
        return { ok: store.release(sessionId, actionId), held: store.isHeld(sessionId) };
      },
    });
    try {
      const payload = { sessionId: 'session-a', actionId: 'action-a', operation: 'hold' };
      const unauthenticated = await app.inject({ method: 'POST', url: '/session-input/hold', payload });
      expect(unauthenticated.statusCode).toBe(401);
      const held = await app.inject({ method: 'POST', url: '/session-input/hold',
                                      headers: { 'x-happier-daemon-token': 'token' }, payload });
      expect(held.statusCode).toBe(200);
      expect(held.json()).toEqual({ ok: true, held: true });
      expect(createSessionInputHoldStore(dir).isHeld('session-a')).toBe(true);
      const wrong = await app.inject({ method: 'POST', url: '/session-input/hold',
                                       headers: { 'x-happier-daemon-token': 'token' },
                                       payload: { ...payload, operation: 'release', actionId: 'action-b' } });
      expect(wrong.statusCode).toBe(409);
      expect(store.isHeld('session-a')).toBe(true);
      const released = await app.inject({ method: 'POST', url: '/session-input/hold',
                                          headers: { 'x-happier-daemon-token': 'token' },
                                          payload: { ...payload, operation: 'release' } });
      expect(released.statusCode).toBe(200);
      expect(store.isHeld('session-a')).toBe(false);
      const status = await app.inject({ method: 'POST', url: '/session-input/hold',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { ...payload, operation: 'status' } });
      expect(status.json()).toEqual({ ok: true, held: false });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('authenticates compact cancellation and rejects a later controlled admit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-usage-control-'));
    const store = createSessionInputHoldStore(dir);
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error' as const,
                                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                                  errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      handleSessionControlledCancel: ({ sessionId, actionId }) => {
        const cancelled = store.cancelIfNoControlledTurn(sessionId, actionId);
        const held = store.isHeld(sessionId);
        return { ok: cancelled && !held, cancelled, held };
      },
      handleSessionControlledSend: async ({ sessionId, actionId }) =>
        store.reserveControlledAdmit(sessionId, actionId)
          ? { ok: true, localId: `usage-${actionId}-compact` }
          : { ok: false, error: 'action_fence_mismatch' },
    });
    try {
      expect(store.hold('session-a', 'action-a')).toBe(true);
      const payload = { sessionId: 'session-a', actionId: 'action-a', kind: 'compact' };
      const denied = await app.inject({ method: 'POST', url: '/session-input/controlled-cancel', payload });
      expect(denied.statusCode).toBe(401);
      const cancelled = await app.inject({ method: 'POST', url: '/session-input/controlled-cancel',
        headers: { 'x-happier-daemon-token': 'token' }, payload });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toEqual({ ok: true, cancelled: true, held: false });
      const admit = await app.inject({ method: 'POST', url: '/session-input/controlled-send',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { ...payload, phase: 'admit' } });
      expect(admit.statusCode).toBe(409);
      expect(store.canControlledWake('session-a', 'action-a', 'compact')).toBe(false);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a controlled compact only through the authenticated action route', async () => {
    const handleSessionControlledSend = async ({ actionId, kind, phase }: {
      actionId: string; kind: 'compact' | 'continue'; phase: 'admit' | 'wake';
    }) => actionId === 'action-a' && kind === 'compact' && phase === 'admit'
      ? { ok: true, localId: 'usage-action-a-compact' }
      : { ok: false, error: 'action_fence_mismatch' };
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error' as const,
                                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                                  errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      handleSessionControlledSend,
    });
    try {
      const payload = { sessionId: 'session-a', actionId: 'action-a', kind: 'compact', phase: 'admit' };
      const denied = await app.inject({ method: 'POST', url: '/session-input/controlled-send', payload });
      expect(denied.statusCode).toBe(401);
      const accepted = await app.inject({ method: 'POST', url: '/session-input/controlled-send',
        headers: { 'x-happier-daemon-token': 'token' }, payload });
      expect(accepted.json()).toEqual({ ok: true, localId: 'usage-action-a-compact' });
      const stale = await app.inject({ method: 'POST', url: '/session-input/controlled-send',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { ...payload, actionId: 'action-b' } });
      expect(stale.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('requires the local token and exact held action for controlled runtime resume', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error' as const,
                                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                                  errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      handleSessionControlledResume: async ({ actionId }) => actionId === 'action-a'
        ? { ok: true, status: 'started' as const }
        : { ok: false, error: 'action_fence_mismatch' },
    });
    try {
      const payload = { sessionId: 'session-a', actionId: 'action-a',
        profileId: 'clemens2', bindingGeneration: 1790445241960 };
      const denied = await app.inject({ method: 'POST', url: '/session-input/controlled-resume', payload });
      expect(denied.statusCode).toBe(401);
      const accepted = await app.inject({ method: 'POST', url: '/session-input/controlled-resume',
        headers: { 'x-happier-daemon-token': 'token' }, payload });
      expect(accepted.json()).toEqual({ ok: true, status: 'started' });
      const stale = await app.inject({ method: 'POST', url: '/session-input/controlled-resume',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { ...payload, actionId: 'action-b' } });
      expect(stale.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
