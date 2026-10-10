import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  resolveConnectedServicesProviderStateSharingPolicyV1,
  type AccountSettings,
  type ConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';

import { codexConnectedServiceStateSharingDescriptor } from '@/backends/codex/connectedServices/codexConnectedServiceStateSharingDescriptor';
import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';
import { ConnectedServiceSharedStateLinkUnavailableError } from '@/daemon/connectedServices/stateSharing/createSharedStateLink';
import { withConnectedServiceStateSharingLocks } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import {
  readConnectedServiceStateSharingManifest,
  removeLegacyConnectedServiceStateSharingManifest,
  writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { applyConnectedServiceStateSharingDescriptor } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import {
  importConnectedServiceSessionFiles,
  type ConnectedServiceSessionFileImportDetail,
} from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';

import { resolveConfiguredCodexSqliteHome } from './codexStateFileNames';
import { reconcileCodexSharedJsonlState } from './reconcileCodexSharedJsonlState';

const CODEX_IMPORTABLE_SESSION_HOME_ENTRIES = Object.freeze([
  'sessions',
  'archived_sessions',
] as const);

const CODEX_SHARED_STATE_DIRECTORY_ENTRIES = Object.freeze([
  'sessions',
  'archived_sessions',
  'memories',
] as const);

const CODEX_SHARED_STATE_FILE_ENTRIES = Object.freeze([
  'session_index.jsonl',
  'history.jsonl',
] as const);

type CodexStateMode = 'shared' | 'isolated';

export type CodexConnectedServiceStateSharingDiagnostic = Readonly<{
  code: 'state_symlink_unavailable';
  providerId: 'codex';
  requestedStateMode: 'shared';
  effectiveStateMode: 'isolated';
  entryName: string;
  reason: 'symlink_unavailable';
  fsCode?: string;
}>;

export type SyncCodexConnectedServiceHomeResult = Readonly<{
  providerId: 'codex';
  requestedStateMode: CodexStateMode;
  effectiveStateMode: CodexStateMode;
  diagnostics: readonly CodexConnectedServiceStateSharingDiagnostic[];
  targetSqliteHome: string;
}>;

function resolveCodexHomeSharingSettings(
  settingsLike: AccountSettings | Readonly<Record<string, unknown>> | null | undefined,
): ConnectedServicesProviderStateSharingPolicyV1 {
  return resolveConnectedServicesProviderStateSharingPolicyV1(
    settingsLike?.connectedServicesProviderStateSharingSettingsV1,
    'codex',
  );
}

function dedupeEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

type CodexHookTrustSection = Readonly<{
  key: string;
  body: string;
  trustedHash?: string;
  enabled?: boolean;
}>;
type CodexHookTrustSnapshot = Readonly<{
  hooksPath: string;
  hooksBytes: Buffer | null;
  sections: readonly CodexHookTrustSection[];
}>;

// Restore the deployed 68f18b5e01/429ebae0f7 intent at its provider owner.
// These are native flat hooks.state sections, not a general TOML parser.
function codexHookTrustKey(line: string): string | null {
  const match = /^\s*\[hooks\.state\.("(?:[^"\\]|\\.)*")\]\s*(?:#.*)?$/.exec(line);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function codexHookTrustSections(content: string, hooksPath: string): readonly CodexHookTrustSection[] {
  const sections: CodexHookTrustSection[] = [];
  let key: string | null = null;
  let body: string[] = [];
  let trustedHash: string | undefined;
  let enabled: boolean | undefined;
  const flush = () => {
    if (key !== null && (trustedHash !== undefined || enabled !== undefined)) {
      sections.push({ key, body: `${body.join('\n').trimEnd()}\n`, trustedHash, enabled });
    }
  };
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      flush();
      const candidate = codexHookTrustKey(line);
      key = candidate?.startsWith(`${hooksPath}:`) ? candidate : null;
      body = [];
      trustedHash = undefined;
      enabled = undefined;
      continue;
    }
    if (key === null) continue;
    body.push(line);
    const enabledMatch = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line);
    if (enabledMatch) {
      enabled = enabledMatch[1] === 'true';
      continue;
    }
    const match = /^\s*trusted_hash\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]);
      trustedHash = typeof value === 'string' ? value : undefined;
      if (trustedHash !== undefined) body[body.length - 1] = `trusted_hash = ${JSON.stringify(trustedHash)}`;
    } catch {
      trustedHash = undefined;
    }
  }
  flush();
  return sections;
}

async function canonicalCodexHome(home: string): Promise<string> {
  const suffix: string[] = [];
  let existing = resolve(home);
  for (;;) {
    try {
      return join(await realpath(existing), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}

async function optionalHookBytes(path: string, requireCopy = false): Promise<Buffer | null> {
  try {
    const stats = await lstat(path);
    if (requireCopy && !stats.isFile()) return null;
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readCodexHookTrustSnapshot(home: string): Promise<CodexHookTrustSnapshot> {
  const canonicalHome = await canonicalCodexHome(home);
  const hooksFile = join(canonicalHome, 'hooks.json');
  const hooksBytes = await optionalHookBytes(hooksFile);
  const hooksPath = hooksBytes === null ? hooksFile : await realpath(hooksFile);
  let config = '';
  try {
    config = await readFile(join(canonicalHome, 'config.toml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  return { hooksPath, hooksBytes, sections: codexHookTrustSections(config, hooksPath) };
}

function remapCodexHookTrustSections(snapshot: CodexHookTrustSnapshot, hooksPath: string): readonly CodexHookTrustSection[] {
  return snapshot.sections.map((section) => ({
    ...section,
    key: `${hooksPath}${section.key.slice(snapshot.hooksPath.length)}`,
  }));
}

function mergeCodexHookTrustSections(base: readonly CodexHookTrustSection[], preferred: readonly CodexHookTrustSection[]): readonly CodexHookTrustSection[] {
  const byKey = new Map(base.map((section) => [section.key, section]));
  for (const section of preferred) {
    const previous = byKey.get(section.key);
    // Native enablement and trust are independent. Explicit source fields win;
    // absent fields retain profile state for the same unchanged hook bytes.
    let body = section.body;
    if (section.trustedHash === undefined && previous?.trustedHash !== undefined) {
      body = `trusted_hash = ${JSON.stringify(previous.trustedHash)}\n${body}`;
    }
    if (section.enabled === undefined && previous?.enabled !== undefined) {
      body = `${body}enabled = ${previous.enabled}\n`;
    }
    byKey.set(section.key, {
      ...section,
      body,
      trustedHash: section.trustedHash ?? previous?.trustedHash,
      enabled: section.enabled ?? previous?.enabled,
    });
  }
  return [...byKey.values()];
}

async function restoreCodexHookTrustSections(home: string, sections: readonly CodexHookTrustSection[]): Promise<boolean> {
  if (sections.length === 0) return false;
  const configPath = join(home, 'config.toml');
  let config = 'cli_auth_credentials_store = "file"\n';
  try {
    config = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  const replaced = new Set(sections.map((section) => section.key));
  let skip = false;
  const retained: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) skip = replaced.has(codexHookTrustKey(line) ?? '');
    if (!skip) retained.push(line);
  }
  const base = retained.join('\n').trimEnd();
  await writeFile(configPath, `${base}${base ? '\n\n' : ''}${sections.map((section) =>
    `[hooks.state.${JSON.stringify(section.key)}]\n${section.body}`).join('\n')}`, 'utf8');
  return true;
}

async function resolveCodexConfigEntryNames(sourceCodexHome: string): Promise<readonly string[]> {
  const names: string[] = [];
  for (const descriptorEntry of codexConnectedServiceStateSharingDescriptor.config.entries) {
    if (descriptorEntry.path !== 'skills') {
      names.push(descriptorEntry.path);
      continue;
    }
    const skillsPath = join(sourceCodexHome, 'skills');
    let childNames: string[];
    try {
      childNames = await readdir(skillsPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') continue;
      throw error;
    }
    for (const childName of childNames) {
      names.push(join('skills', childName));
    }
  }
  return dedupeEntries(names);
}

function toStateSymlinkUnavailableDiagnostic(
  error: ConnectedServiceSharedStateLinkUnavailableError,
): CodexConnectedServiceStateSharingDiagnostic {
  return {
    code: 'state_symlink_unavailable',
    providerId: 'codex',
    requestedStateMode: 'shared',
    effectiveStateMode: 'isolated',
    entryName: error.entryName,
    reason: 'symlink_unavailable',
    ...(error.fsCode ? { fsCode: error.fsCode } : {}),
  };
}

function resolveSourceCodexHome(params: Readonly<{
  destinationCodexHome: string;
  processEnv: NodeJS.ProcessEnv;
}>): string | null {
  const sourceCodexHome = resolve(resolveConfiguredCodexHome(params.processEnv));
  if (sourceCodexHome === resolve(params.destinationCodexHome)) return null;
  return sourceCodexHome;
}

function resolveVendorResumeIdFromImportedRollout(
  detail: ConnectedServiceSessionFileImportDetail,
): string | null {
  const candidates = [basename(detail.sourcePath), basename(detail.destinationPath), detail.relativePath];
  for (const candidate of candidates) {
    const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(candidate);
    if (match) return match[1];
  }
  return null;
}

async function ensureNativeCodexSharedStateStore(sourceCodexHome: string): Promise<void> {
  await mkdir(sourceCodexHome, { recursive: true });
  await Promise.all(CODEX_SHARED_STATE_DIRECTORY_ENTRIES.map(async (entryName) => {
    await mkdir(join(sourceCodexHome, entryName), { recursive: true });
  }));
  await Promise.all(CODEX_SHARED_STATE_FILE_ENTRIES.map(async (entryName) => {
    const handle = await open(join(sourceCodexHome, entryName), 'a');
    await handle.close();
  }));
}

async function backfillPreviousCodexNonSessionState(params: Readonly<{
  previousCodexHome?: string | null;
  sourceCodexHome: string;
}>): Promise<void> {
  if (!params.previousCodexHome) return;
  await importConnectedServiceSessionFiles({
    roots: [{
      sourceRoot: params.previousCodexHome,
      destinationRoot: params.sourceCodexHome,
      includeDirectory: (relativePath) =>
        relativePath === 'memories' || relativePath.startsWith('memories/'),
      includeFile: (relativePath) =>
        relativePath.startsWith('memories/'),
    }],
  });
  await reconcileCodexSharedJsonlState(params);
}

async function withCodexSharedStatePreflightSource<T>(params: Readonly<{
  enabled: boolean;
  sourceCodexHome: string;
  run: (preflightSourceCodexHome: string | null) => Promise<T>;
}>): Promise<T> {
  if (!params.enabled) return await params.run(null);
  await mkdir(params.sourceCodexHome, { recursive: true });
  const preflightSourceCodexHome = await mkdtemp(join(params.sourceCodexHome, '.happier-state-preflight-'));
  try {
    await Promise.all(CODEX_SHARED_STATE_DIRECTORY_ENTRIES.map(async (entryName) => {
      await mkdir(join(preflightSourceCodexHome, entryName), { recursive: true });
    }));
    await Promise.all(CODEX_SHARED_STATE_FILE_ENTRIES.map(async (entryName) => {
      const handle = await open(join(preflightSourceCodexHome, entryName), 'w');
      await handle.close();
    }));
    return await params.run(preflightSourceCodexHome);
  } finally {
    await rm(preflightSourceCodexHome, { recursive: true, force: true });
  }
}

export async function syncCodexConnectedServiceHome(params: Readonly<{
  destinationCodexHome: string;
  previousCodexHome?: string | null;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<SyncCodexConnectedServiceHomeResult> {
  const settings = resolveCodexHomeSharingSettings(params.accountSettings ?? null);
  const processEnv = params.processEnv ?? process.env;
  const sourceCodexHome = resolveSourceCodexHome({
    destinationCodexHome: params.destinationCodexHome,
    processEnv,
  });
  const lockRoots = settings.stateMode === 'shared' && sourceCodexHome
    ? [params.destinationCodexHome, sourceCodexHome]
    : [params.destinationCodexHome];
  return await withConnectedServiceStateSharingLocks(lockRoots, async () => {
    const sourceSqliteHome = resolve(resolveConfiguredCodexSqliteHome(processEnv));
    if (!sourceCodexHome) {
      return {
        providerId: 'codex',
        requestedStateMode: settings.stateMode,
        effectiveStateMode: settings.stateMode,
        diagnostics: [],
        targetSqliteHome: settings.stateMode === 'shared'
          ? sourceSqliteHome
          : params.destinationCodexHome,
      };
    }

    await mkdir(params.destinationCodexHome, { recursive: true });
    const manifest = await readConnectedServiceStateSharingManifest(params.destinationCodexHome);
    const effectiveCodexHome = await canonicalCodexHome(params.previousCodexHome ?? params.destinationCodexHome);
    const previousHookTrust = settings.configMode === 'isolated'
      ? null : await readCodexHookTrustSnapshot(effectiveCodexHome);
    const configEntryNames = await resolveCodexConfigEntryNames(sourceCodexHome);
    const stateEntryNames = codexConnectedServiceStateSharingDescriptor.state.entries.map((entry) => entry.path);

    const applyResult = await withCodexSharedStatePreflightSource({
      enabled: settings.stateMode === 'shared',
      sourceCodexHome,
      run: async (preflightSourceCodexHome) => await applyConnectedServiceStateSharingDescriptor({
        descriptor: codexConnectedServiceStateSharingDescriptor,
        nativeSourceContext: {
          sourceRoot: sourceCodexHome,
          sourceEnv: processEnv as Record<string, string>,
        },
        target: {
          targetMaterializedRoot: params.destinationCodexHome,
          targetMaterializedEnv: {},
        },
        configMode: settings.configMode,
        requestedStateMode: settings.stateMode,
        effectiveStateMode: settings.stateMode,
        cwd: process.cwd(),
        existingManifest: manifest,
        configEntryNames,
        stateEntryNames,
        prepareSharedStateSource: preflightSourceCodexHome ? async () => {
          await backfillPreviousCodexNonSessionState({
            previousCodexHome: params.previousCodexHome ?? null,
            sourceCodexHome,
          });
          await ensureNativeCodexSharedStateStore(sourceCodexHome);
        } : undefined,
        resolveStatePreflightSourceRoot: preflightSourceCodexHome
          ? () => preflightSourceCodexHome
          : undefined,
        resolveStateSourceRoot: () => sourceCodexHome,
        mapStateSymlinkUnavailableDiagnostic: (error) => toStateSymlinkUnavailableDiagnostic(error),
        sessionImportRoots: settings.stateMode === 'shared'
          ? dedupeEntries([
            resolve(params.destinationCodexHome),
            ...(params.previousCodexHome ? [resolve(params.previousCodexHome)] : []),
          ]).flatMap((sessionSourceHome) => CODEX_IMPORTABLE_SESSION_HOME_ENTRIES.map((entryName) => ({
            sourceRoot: join(sessionSourceHome, entryName),
            destinationRoot: join(sourceCodexHome, entryName),
            includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
          })))
          : [],
        resolveVendorResumeIdFromImportedFile: resolveVendorResumeIdFromImportedRollout,
        providerLabel: 'Codex',
      }),
    });

    let restoredHookTrust = false;
    if (settings.configMode !== 'isolated') {
      const copiedHooks = await optionalHookBytes(join(params.destinationCodexHome, 'hooks.json'), true);
      const nativeHookTrust = await readCodexHookTrustSnapshot(sourceCodexHome);
      const finalHooksPath = join(effectiveCodexHome, 'hooks.json');
      const retained = copiedHooks !== null && previousHookTrust !== null
        && previousHookTrust.hooksBytes !== null && previousHookTrust.hooksBytes.equals(copiedHooks)
        ? remapCodexHookTrustSections(previousHookTrust, finalHooksPath) : [];
      const transferred = copiedHooks !== null && nativeHookTrust.hooksBytes?.equals(copiedHooks)
        ? remapCodexHookTrustSections(nativeHookTrust, finalHooksPath) : [];
      restoredHookTrust = await restoreCodexHookTrustSections(params.destinationCodexHome,
        mergeCodexHookTrustSections(retained, transferred));
    }
    const nextManifest = restoredHookTrust && !applyResult.manifest.configEntries.includes('config.toml')
      ? { ...applyResult.manifest, configEntries: [...applyResult.manifest.configEntries, 'config.toml'] }
      : applyResult.manifest;
    await writeConnectedServiceStateSharingManifest(params.destinationCodexHome, nextManifest);
    await removeLegacyConnectedServiceStateSharingManifest(params.destinationCodexHome);

    return {
      providerId: 'codex',
      requestedStateMode: settings.stateMode,
      effectiveStateMode: applyResult.manifest.effectiveStateMode,
      diagnostics: applyResult.diagnostics as readonly CodexConnectedServiceStateSharingDiagnostic[],
      targetSqliteHome: applyResult.manifest.effectiveStateMode === 'shared'
        ? sourceSqliteHome
        : params.destinationCodexHome,
    };
  }, { providerId: 'codex' });
}
