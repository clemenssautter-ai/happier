import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

describe('happier session send local identity (HTTP corridor)', () => {
  const sessionId = 'sess_local_identity_123';
  const localId = '0a5b2df8-13eb-4a9e-8a91-524fc79ae637';
  const envKeys = [
    'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR',
    'HAPPIER_SESSION_ID', 'HAPPIER_ACTIONS_SETTINGS_V1',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let homeDir = '';
  let received: Record<string, unknown>[] = [];

  const readCredentialsFn = async () => ({
    token: 'token_test',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
  });

  beforeEach(async () => {
    homeDir = await createTempDir('happier-cli-send-local-id-');
    received = [];
    // Only the relay boundary is simulated; parser, action schema/executor,
    // CLI dependencies, admission, encryption and Axios all remain real.
    server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === `/v2/sessions/${sessionId}`) {
        res.end(JSON.stringify({ session: {
          id: sessionId, seq: 1, createdAt: 1, updatedAt: 2,
          active: false, activeAt: 0, archivedAt: null,
          metadata: JSON.stringify({ permissionMode: 'default' }), metadataVersion: 0,
          agentState: null, agentStateVersion: 0, pendingCount: 0, pendingVersion: 0,
          dataEncryptionKey: null, encryptionMode: 'plain', share: null,
        } }));
        return;
      }
      if (req.method === 'POST' && path === `/v2/sessions/${sessionId}/pending`) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        received.push(body);
        // A valid existing-terminal acknowledgement completes the send without
        // launching a provider, while retaining real HTTP identity validation.
        res.end(JSON.stringify({ didWrite: false, terminal: true, message: {
          id: 'message_1', seq: 1, localId: body.localId, requestedAction: body.requestedAction,
        } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP test server address');
    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SESSION_ID: undefined,
      HAPPIER_ACTIONS_SETTINGS_V1: undefined,
    });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = null;
    if (homeDir) await removeTempDir(homeDir);
    homeDir = '';
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it.each([
    ['explicit UUID', ['send', sessionId, 'Board wake', '--local-id', localId, '--json'], localId],
    ['opaque bytes and flag before positionals', ['send', '--local-id', ' opaque wake id ', sessionId, 'Board wake', '--json'], ' opaque wake id '],
  ])('preserves %s in the HTTP pending message and CLI response', async (_label, argv, expectedLocalId) => {
    const { cmdSessionSend } = await import('./send');
    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionSend(argv, { readCredentialsFn });
      expect(received).toEqual([expect.objectContaining({
        localId: expectedLocalId,
        content: { t: 'plain', v: expect.objectContaining({
          role: 'user', content: { type: 'text', text: 'Board wake' },
        }) },
      })]);
      expect(output.json()).toMatchObject({
        ok: true, kind: 'session_send',
        data: { sessionId, localId: expectedLocalId, waited: false },
      });
    } finally {
      output.restore();
    }
  });

  it('still generates a local identity when the flag is omitted', async () => {
    const { cmdSessionSend } = await import('./send');
    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionSend(['send', sessionId, 'Board wake', '--json'], { readCredentialsFn });
      const generated = received[0]?.localId;
      expect(generated).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
      expect(output.json()).toMatchObject({ ok: true, data: { sessionId, localId: generated } });
    } finally {
      output.restore();
    }
  });

  it('preserves an opaque identity from a public session.message.send action', async () => {
    const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({ credentials: await readCredentialsFn() });
    const identity = ' action wake id\t';
    const result = await executor.execute('session.message.send', {
      sessionId, message: 'Action wake', localId: identity,
    }, { surface: 'cli', defaultSessionId: null });
    expect(received).toEqual([expect.objectContaining({ localId: identity })]);
    expect(result).toMatchObject({ ok: true, result: { ok: true, sessionId, localId: identity } });
  });

  it.each(['', '   ', null, 42, 'agent-transition:claim-1'])('rejects invalid public action localId %j before HTTP admission', async (invalidLocalId) => {
    const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({ credentials: await readCredentialsFn() });
    await expect(executor.execute('session.message.send', {
      sessionId, message: 'Action wake', localId: invalidLocalId,
    }, { surface: 'cli', defaultSessionId: null })).resolves.toMatchObject({
      ok: false, errorCode: 'invalid_parameters',
    });
    expect(received).toEqual([]);
  });

  it('rejects caller-supplied identity on the MCP surface before HTTP admission', async () => {
    const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({ credentials: await readCredentialsFn() });
    await expect(executor.execute('session.message.send', {
      sessionId, message: 'Action wake', localId,
    }, { surface: 'mcp', defaultSessionId: null })).resolves.toMatchObject({
      ok: false, errorCode: 'invalid_parameters',
    });
    expect(received).toEqual([]);
  });

  it.each([
    ['send', sessionId, 'Board wake', '--local-id'],
    ['send', sessionId, 'Board wake', '--local-id', ''],
    ['send', sessionId, 'Board wake', '--local-id', '   '],
    ['send', sessionId, 'Board wake', '--local-id', '--json'],
    ['send', sessionId, 'Board wake', '--local-id', 'agent-transition:claim-1'],
  ])('rejects a missing, blank or reserved --local-id before reading credentials: %j', async (...argv) => {
    const { cmdSessionSend } = await import('./send');
    const readCredentials = vi.fn(readCredentialsFn);
    await expect(cmdSessionSend(argv, { readCredentialsFn: readCredentials }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(readCredentials).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });
});
