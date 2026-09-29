import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

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
import { capturePreviousCodexHooksCopy, writeCodexHooksCopyReceipt } from './codexHooksCopyReceipt';
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

function codexHookTrustSections(content: string, hooksPath: string): readonly string[] {
  const sections: string[] = [];
  let sectionHeader: string | null = null;
  let trustedHash: string | null = null;
  const flush = () => {
    if (sectionHeader && trustedHash) {
      sections.push(`${sectionHeader}\ntrusted_hash = ${JSON.stringify(trustedHash)}\n`);
    }
  };
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      flush();
      sectionHeader = null;
      trustedHash = null;
      const match = /^\[hooks\.state\.("(?:[^"\\]|\\.)*")\]\s*$/.exec(line);
      if (!match) continue;
      try {
        const hookId: unknown = JSON.parse(match[1]);
        if (typeof hookId === 'string' && hookId.startsWith(`${hooksPath}:`)) sectionHeader = line;
      } catch {
        // A malformed section is left to Codex's config parser; it is never carried as trust.
      }
      continue;
    }
    if (!sectionHeader) continue;
    const match = /^\s*trusted_hash\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(line);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]);
      if (typeof value === 'string' && value.length > 0) trustedHash = value;
    } catch {
      // Ignore invalid trust values.
    }
  }
  flush();
  return sections;
}

function stripCodexHookTrustSections(content: string, hooksPath: string): string {
  let skip = false;
  const retained: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      skip = false;
      const match = /^\[hooks\.state\.("(?:[^"\\]|\\.)*")\]\s*$/.exec(line);
      if (match) {
        try {
          const hookId: unknown = JSON.parse(match[1]);
          skip = typeof hookId === 'string' && hookId.startsWith(`${hooksPath}:`);
        } catch {
          // Keep invalid source content intact.
        }
      }
    }
    if (!skip) retained.push(line);
  }
  return retained.join('\n').trimEnd();
}

async function readCodexHookTrustSections(effectiveCodexHome: string): Promise<readonly string[]> {
  const configPath = join(effectiveCodexHome, 'config.toml');
  try {
    if (!(await lstat(configPath)).isFile()) return [];
    return codexHookTrustSections(await readFile(configPath, 'utf8'), join(effectiveCodexHome, 'hooks.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readFileSha256(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

function sectionHeaderOf(section: string): string {
  return section.slice(0, section.indexOf('\n'));
}

/**
 * Codex keys hook trust by the absolute hooks.json path. A materialized profile copy therefore starts
 * untrusted even when its hooks are byte-identical to the native ones the user already trusted.
 * Carry the native trust over to the profile path, but only when both hooks.json files hash identically;
 * any divergence carries nothing, so Codex asks for trust again as designed.
 */
async function readNativeCodexHookTrustSectionsForProfile(params: Readonly<{
  sourceCodexHome: string;
  destinationCodexHome: string;
  effectiveCodexHome: string;
}>): Promise<readonly string[]> {
  const sourceHooksPath = join(params.sourceCodexHome, 'hooks.json');
  const targetHooksPath = join(params.effectiveCodexHome, 'hooks.json');
  if (targetHooksPath === sourceHooksPath) return [];
  const sourceHash = await readFileSha256(sourceHooksPath);
  if (!sourceHash) return [];
  if (sourceHash !== await readFileSha256(join(params.destinationCodexHome, 'hooks.json'))) return [];
  const nativeSections = await readCodexHookTrustSections(params.sourceCodexHome);
  return nativeSections.map((section) => {
    const header = sectionHeaderOf(section);
    const hookId = JSON.parse(/^\[hooks\.state\.("(?:[^"\\]|\\.)*")\]/.exec(header)![1]) as string;
    const rewritten = `${targetHooksPath}${hookId.slice(sourceHooksPath.length)}`;
    return `[hooks.state.${JSON.stringify(rewritten)}]${section.slice(header.length)}`;
  });
}

function mergeCodexHookTrustSections(base: readonly string[], preferred: readonly string[]): readonly string[] {
  const byHeader = new Map<string, string>();
  for (const section of [...base, ...preferred]) byHeader.set(sectionHeaderOf(section), section);
  return [...byHeader.values()];
}

async function restoreCodexHookTrustSections(params: Readonly<{
  destinationCodexHome: string;
  effectiveCodexHome: string;
  sections: readonly string[];
}>): Promise<boolean> {
  if (params.sections.length === 0) return false;
  const configPath = join(params.destinationCodexHome, 'config.toml');
  let content = '';
  try {
    content = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  const retained = stripCodexHookTrustSections(content, join(params.effectiveCodexHome, 'hooks.json'));
  await writeFile(configPath, `${retained}${retained ? '\n\n' : ''}${params.sections.join('\n')}`, 'utf8');
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
    const previousHooksCopy = await capturePreviousCodexHooksCopy({
      sourceCodexHome,
      destinationCodexHome: params.destinationCodexHome,
      previousCodexHome: params.previousCodexHome ?? null,
    });
    const manifest = await readConnectedServiceStateSharingManifest(params.destinationCodexHome);
    const hookTrustSections = settings.configMode === 'isolated'
      ? []
      : await readCodexHookTrustSections(params.previousCodexHome ?? params.destinationCodexHome);
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

    const effectiveCodexHome = params.previousCodexHome ?? params.destinationCodexHome;
    const nativeHookTrustSections = settings.configMode === 'isolated'
      ? []
      : await readNativeCodexHookTrustSectionsForProfile({
        sourceCodexHome,
        destinationCodexHome: params.destinationCodexHome,
        effectiveCodexHome,
      });
    const restoredHookTrust = settings.configMode === 'isolated'
      ? false
      : await restoreCodexHookTrustSections({
        destinationCodexHome: params.destinationCodexHome,
        effectiveCodexHome,
        sections: mergeCodexHookTrustSections(hookTrustSections, nativeHookTrustSections),
      });
    const nextManifest = restoredHookTrust && !applyResult.manifest.configEntries.includes('config.toml')
      ? { ...applyResult.manifest, configEntries: [...applyResult.manifest.configEntries, 'config.toml'] }
      : applyResult.manifest;
    await writeConnectedServiceStateSharingManifest(params.destinationCodexHome, nextManifest);
    await removeLegacyConnectedServiceStateSharingManifest(params.destinationCodexHome);
    await writeCodexHooksCopyReceipt({
      sourceCodexHome,
      destinationCodexHome: params.destinationCodexHome,
      previousCodexHome: params.previousCodexHome ?? null,
      previous: previousHooksCopy,
    });

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
