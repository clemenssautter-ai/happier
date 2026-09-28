import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { expect, it } from 'vitest';

import { CODEX_HOOKS_COPY_RECEIPT_NAME } from '@/backends/codex/connectedServices/codexHooksCopyReceipt';
import { readConnectedServiceStateSharingManifest } from '../stateSharing/connectedServiceStateSharingManifest';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';

const firstHooks = '{"hooks":{"Stop":[]}}\n';
const secondHooks = '{"hooks":{"SessionStart":[]}}\n';

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

it('proves two real Codex materializations migrate an old hooks link and refresh a copied file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-hooks-canary-'));
  const sourceHome = join(root, 'source-codex-home');
  const baseDir = join(root, 'materialized');
  const activeServerDir = join(root, 'server');
  const materializationKey = 'synthetic-codex-hooks-canary';
  const materializationRoot = resolveConnectedServiceMaterializedRootDir({
    baseDir,
    agentId: 'codex',
    materializationKey,
  });
  const targetHome = join(materializationRoot, 'codex-home');
  const sourceHooksPath = join(sourceHome, 'hooks.json');
  const targetHooksPath = join(targetHome, 'hooks.json');
  const proofPath = process.env.HAPPIER_CODEX_HOOKS_CANARY_PROOF ?? null;
  let proofWritten = false;
  const record = buildConnectedServiceCredentialRecord({
    now: 10,
    serviceId: 'openai-codex',
    profileId: 'synthetic',
    kind: 'oauth',
    expiresAt: null,
    oauth: {
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      idToken: 'synthetic-id',
      scope: null,
      tokenType: null,
      providerAccountId: 'synthetic-account',
      providerEmail: null,
    },
  });

  try {
    await mkdir(sourceHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await mkdir(activeServerDir, { recursive: true });
    await writeFile(sourceHooksPath, firstHooks);
    await symlink(sourceHooksPath, targetHooksPath, 'file');
    await writeFile(join(targetHome, '.happier-state-sharing.json'), JSON.stringify({
      v: 1,
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      configEntries: ['hooks.json'],
      stateEntries: [],
    }));
    const legacyStat = await lstat(targetHooksPath);
    const legacyLinkTarget = await readlink(targetHooksPath);
    expect(legacyStat.isSymbolicLink()).toBe(true);
    expect(legacyLinkTarget).toBe(sourceHooksPath);

    const accountSettings = {
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: { configMode: 'linked', stateMode: 'isolated' },
        byAgentId: { codex: { configMode: 'linked', stateMode: 'isolated' } },
        acknowledgedRisksByAgentId: {},
      },
    };
    const materialize = async () => await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey,
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      accountSettings,
      processEnv: { CODEX_HOME: sourceHome, HOME: root },
    });
    const snapshot = async () => {
      const sourceStat = await lstat(sourceHooksPath);
      const targetStat = await lstat(targetHooksPath);
      const manifest = await readConnectedServiceStateSharingManifest(targetHome);
      const receipt = JSON.parse(await readFile(join(targetHome, CODEX_HOOKS_COPY_RECEIPT_NAME), 'utf8'));
      return {
        sourceSha256: sha256(await readFile(sourceHooksPath)),
        targetSha256: sha256(await readFile(targetHooksPath)),
        source: { path: sourceHooksPath, dev: sourceStat.dev, ino: sourceStat.ino },
        target: {
          path: targetHooksPath,
          dev: targetStat.dev,
          ino: targetStat.ino,
          regularFile: targetStat.isFile(),
          symbolicLink: targetStat.isSymbolicLink(),
        },
        manifest: {
          requestedStateMode: manifest.requestedStateMode,
          effectiveStateMode: manifest.effectiveStateMode,
          lastSyncAtMs: manifest.lastSyncAtMs,
          configEntries: manifest.configEntries,
          stateEntries: manifest.stateEntries,
          diagnostics: manifest.diagnostics,
        },
        receipt,
      };
    };

    const first = await materialize();
    expect(first?.env.CODEX_HOME).toBe(targetHome);
    const afterFirst = await snapshot();
    expect(afterFirst.target.regularFile).toBe(true);
    expect(afterFirst.target.symbolicLink).toBe(false);
    expect(afterFirst.targetSha256).toBe(sha256(firstHooks));
    expect(afterFirst.manifest.configEntries).toContain('hooks.json');
    expect(afterFirst.receipt.previous).toBeNull();
    expect(afterFirst.receipt.current.source.sha256).toBe(sha256(firstHooks));
    expect(afterFirst.receipt.current.target.sha256).toBe(sha256(firstHooks));

    await writeFile(sourceHooksPath, secondHooks);
    const beforeSecond = await snapshot();
    expect(beforeSecond.sourceSha256).toBe(sha256(secondHooks));
    expect(beforeSecond.targetSha256).toBe(sha256(firstHooks));

    const second = await materialize();
    expect(second?.env.CODEX_HOME).toBe(targetHome);
    const afterSecond = await snapshot();
    expect(afterSecond.target.regularFile).toBe(true);
    expect(afterSecond.target.symbolicLink).toBe(false);
    expect(afterSecond.targetSha256).toBe(afterSecond.sourceSha256);
    expect(afterSecond.targetSha256).toBe(sha256(secondHooks));
    expect(afterSecond.receipt.previous.nonce).toBe(afterFirst.receipt.current.nonce);
    expect(afterSecond.receipt.previousTargetBeforeSync.sha256).toBe(sha256(firstHooks));
    expect(afterSecond.receipt.current.source.sha256).toBe(sha256(secondHooks));
    expect(afterSecond.receipt.current.target.sha256).toBe(sha256(secondHooks));
    expect(afterSecond.receipt.loadedModule.sha256).toMatch(/^[a-f0-9]{64}$/);

    if (proofPath) {
      await mkdir(dirname(proofPath), { recursive: true });
      await writeFile(proofPath, `${JSON.stringify({
        schemaVersion: 1,
        runner: 'vitest-transformed-source',
        loadedDaemonBuildVerified: false,
        nodeVersion: process.version,
        sourceIdentity: {
          materializerSourceSha256: sha256(await readFile(new URL('./materializeConnectedServicesForSpawn.ts', import.meta.url))),
          codexSyncSourceSha256: sha256(await readFile(new URL('../../../backends/codex/connectedServices/syncCodexConnectedServiceHome.ts', import.meta.url))),
          codexDescriptorSourceSha256: sha256(await readFile(new URL('../../../backends/codex/connectedServices/codexConnectedServiceStateSharingDescriptor.ts', import.meta.url))),
        },
        fixtureRoot: root,
        serviceId: 'openai-codex',
        profileId: 'synthetic',
        materializationKey,
        materializationRoot,
        sourceHome,
        targetHome,
        legacy: {
          linkPath: targetHooksPath,
          linkTarget: legacyLinkTarget,
          symbolicLink: legacyStat.isSymbolicLink(),
          dev: legacyStat.dev,
          ino: legacyStat.ino,
        },
        afterFirst,
        beforeSecond,
        afterSecond,
      }, null, 2)}\n`);
      proofWritten = true;
    }
  } finally {
    if (!proofWritten) await rm(root, { recursive: true, force: true });
  }
});
