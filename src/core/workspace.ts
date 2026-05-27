import path from 'node:path';
import * as fs from './fs.js';
import { createGitSourceFromUrl } from './git-sources.js';
import type {
  GitSource,
  LatestPolicy,
  RangeResolutionPolicy,
  TagResolutionPolicy,
} from '../types.js';

export const workspaceConfigFileName = 'airgap-sync.json';
export const workspaceSecretsFileName = 'airgap-sync.secrets.json';
export const defaultWorkspaceOutputDir = './airgap-bundle';
export const defaultWorkspaceSourceRegistry = 'https://registry.npmjs.org';

export interface WorkspaceGitTarget {
  branch?: string;
  type: 'git';
  url: string;
}

export interface WorkspaceNpmTarget {
  spec: string;
  type: 'npm';
}

export type WorkspaceTarget = WorkspaceGitTarget | WorkspaceNpmTarget;
export type WorkspacePromptBoolean = boolean | 'ask';

export interface WorkspaceDefaults {
  download: {
    includeDev: WorkspacePromptBoolean;
    includePeer: WorkspacePromptBoolean;
    latestPolicy: LatestPolicy;
    prune: WorkspacePromptBoolean;
    rangeResolutionPolicy: RangeResolutionPolicy;
    tagResolutionPolicy: TagResolutionPolicy;
  };
  publish: {
    configureGitGlobal: WorkspacePromptBoolean;
    publicRepositories: WorkspacePromptBoolean;
  };
  verifyInstall: {
    ignoreScripts: WorkspacePromptBoolean;
  };
}

export interface WorkspaceConfig {
  defaults: WorkspaceDefaults;
  giteaUrl?: string;
  output: string;
  schemaVersion: 1;
  sourceRegistry: string;
  targetRegistry?: string;
  targets: WorkspaceTarget[];
}

export interface WorkspaceSecrets {
  giteaToken?: string;
  schemaVersion: 1;
}

interface WorkspaceGitTargetSnapshot {
  branch?: string;
  localMirrorPath: string;
  sourceId: string;
  type: 'git';
  url: string;
}

interface WorkspaceNpmTargetSnapshot {
  spec: string;
  type: 'npm';
}

export type WorkspaceTargetSnapshot = WorkspaceGitTargetSnapshot | WorkspaceNpmTargetSnapshot;

export interface WorkspaceSnapshot {
  createdAt: string;
  output: string;
  schemaVersion: 1;
  sourceRegistry: string;
  targets: WorkspaceTargetSnapshot[];
}

export interface InitWorkspaceOptions {
  force?: boolean;
  workspaceDir: string;
}

export interface CreateWorkspaceSnapshotOptions {
  config: WorkspaceConfig;
  createdAt?: string;
}

export interface SelectWorkspaceTargetsResult {
  config: WorkspaceConfig;
  selectedIndexes: number[];
  selectedTargets: WorkspaceTarget[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createDefaultWorkspaceConfig(): WorkspaceConfig {
  return {
    defaults: {
      download: {
        includeDev: 'ask',
        includePeer: false,
        latestPolicy: 'bundled',
        prune: false,
        rangeResolutionPolicy: 'reuse-stable',
        tagResolutionPolicy: 'reuse-stable',
      },
      publish: {
        configureGitGlobal: 'ask',
        publicRepositories: false,
      },
      verifyInstall: {
        ignoreScripts: true,
      },
    },
    output: defaultWorkspaceOutputDir,
    schemaVersion: 1,
    sourceRegistry: defaultWorkspaceSourceRegistry,
    targets: [],
  };
}

function createDefaultWorkspaceSecrets(): WorkspaceSecrets {
  return {
    schemaVersion: 1,
  };
}

export function workspaceConfigPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), workspaceConfigFileName);
}

export function workspaceSecretsPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), workspaceSecretsFileName);
}

function normalizeWorkspaceTarget(value: unknown): WorkspaceTarget {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Workspace target must be an object with a type');
  }

  if (value.type === 'git') {
    if (typeof value.url !== 'string' || value.url.trim().length === 0) {
      throw new Error('Git target must include a non-empty url');
    }

    return {
      ...(typeof value.branch === 'string' && value.branch.trim().length > 0
        ? { branch: value.branch.trim() }
        : {}),
      type: 'git',
      url: value.url.trim(),
    };
  }

  if (value.type === 'npm') {
    if (typeof value.spec !== 'string' || value.spec.trim().length === 0) {
      throw new Error('npm target must include a non-empty spec');
    }

    return {
      spec: value.spec.trim(),
      type: 'npm',
    };
  }

  throw new Error(`Unsupported workspace target type: ${value.type}`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePromptBoolean(
  value: unknown,
  fallback: WorkspacePromptBoolean
): WorkspacePromptBoolean {
  if (value === true || value === false || value === 'ask') {
    return value;
  }

  return fallback;
}

function normalizeLatestPolicy(value: unknown, fallback: LatestPolicy): LatestPolicy {
  return value === 'source' || value === 'bundled' ? value : fallback;
}

function normalizeTagResolutionPolicy(
  value: unknown,
  fallback: TagResolutionPolicy
): TagResolutionPolicy {
  return value === 'refresh' || value === 'reuse-stable' ? value : fallback;
}

function normalizeRangeResolutionPolicy(
  value: unknown,
  fallback: RangeResolutionPolicy
): RangeResolutionPolicy {
  return value === 'refresh' || value === 'reuse-stable' ? value : fallback;
}

function normalizeWorkspaceDefaults(value: unknown): WorkspaceDefaults {
  const defaults = createDefaultWorkspaceConfig().defaults;
  const input = isRecord(value) ? value : {};
  const download = isRecord(input.download) ? input.download : {};
  const publish = isRecord(input.publish) ? input.publish : {};
  const verifyInstall = isRecord(input.verifyInstall) ? input.verifyInstall : {};

  return {
    download: {
      includeDev: normalizePromptBoolean(download.includeDev, defaults.download.includeDev),
      includePeer: normalizePromptBoolean(download.includePeer, defaults.download.includePeer),
      latestPolicy: normalizeLatestPolicy(download.latestPolicy, defaults.download.latestPolicy),
      prune: normalizePromptBoolean(download.prune, defaults.download.prune),
      rangeResolutionPolicy: normalizeRangeResolutionPolicy(
        download.rangeResolutionPolicy,
        defaults.download.rangeResolutionPolicy
      ),
      tagResolutionPolicy: normalizeTagResolutionPolicy(
        download.tagResolutionPolicy,
        defaults.download.tagResolutionPolicy
      ),
    },
    publish: {
      configureGitGlobal: normalizePromptBoolean(
        publish.configureGitGlobal,
        defaults.publish.configureGitGlobal
      ),
      publicRepositories: normalizePromptBoolean(
        publish.publicRepositories,
        defaults.publish.publicRepositories
      ),
    },
    verifyInstall: {
      ignoreScripts: normalizePromptBoolean(
        verifyInstall.ignoreScripts,
        defaults.verifyInstall.ignoreScripts
      ),
    },
  };
}

function normalizeWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (!isRecord(value)) {
    throw new Error(`${workspaceConfigFileName} must contain a JSON object`);
  }

  if (value.schemaVersion !== 1) {
    throw new Error(`${workspaceConfigFileName} schemaVersion must be 1`);
  }

  const targets = Array.isArray(value.targets)
    ? value.targets.map((target) => normalizeWorkspaceTarget(target))
    : [];
  const giteaUrl = optionalString(value.giteaUrl);
  const targetRegistry = optionalString(value.targetRegistry);

  return {
    defaults: normalizeWorkspaceDefaults(value.defaults),
    ...(giteaUrl ? { giteaUrl } : {}),
    output:
      typeof value.output === 'string' && value.output.trim().length > 0
        ? value.output.trim()
        : defaultWorkspaceOutputDir,
    schemaVersion: 1,
    sourceRegistry:
      typeof value.sourceRegistry === 'string' && value.sourceRegistry.trim().length > 0
        ? value.sourceRegistry.trim()
        : defaultWorkspaceSourceRegistry,
    ...(targetRegistry ? { targetRegistry } : {}),
    targets,
  };
}

function normalizeWorkspaceSecrets(value: unknown): WorkspaceSecrets {
  if (!isRecord(value)) {
    throw new Error(`${workspaceSecretsFileName} must contain a JSON object`);
  }

  if (value.schemaVersion !== 1) {
    throw new Error(`${workspaceSecretsFileName} schemaVersion must be 1`);
  }

  const giteaToken = optionalString(value.giteaToken);
  return {
    ...(giteaToken ? { giteaToken } : {}),
    schemaVersion: 1,
  };
}

export async function initWorkspace(options: InitWorkspaceOptions): Promise<WorkspaceConfig> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const configPath = workspaceConfigPath(workspaceDir);
  if ((await fs.pathExists(configPath)) && options.force !== true) {
    throw new Error(`${workspaceConfigFileName} already exists in ${workspaceDir}`);
  }

  const config = createDefaultWorkspaceConfig();
  await fs.writeJson(configPath, config, { spaces: 2 });
  await fs.ensureDir(path.resolve(workspaceDir, config.output));
  return config;
}

export async function readWorkspaceConfig(workspaceDir: string): Promise<WorkspaceConfig> {
  return normalizeWorkspaceConfig(await fs.readJson(workspaceConfigPath(workspaceDir)));
}

export async function readWorkspaceSecrets(workspaceDir: string): Promise<WorkspaceSecrets> {
  const secretsPath = workspaceSecretsPath(workspaceDir);
  if (!(await fs.pathExists(secretsPath))) {
    return createDefaultWorkspaceSecrets();
  }

  return normalizeWorkspaceSecrets(await fs.readJson(secretsPath));
}

export async function writeWorkspaceConfig(
  workspaceDir: string,
  config: WorkspaceConfig
): Promise<void> {
  await fs.writeJson(workspaceConfigPath(workspaceDir), config, { spaces: 2 });
}

export async function writeWorkspaceSecrets(
  workspaceDir: string,
  secrets: WorkspaceSecrets
): Promise<void> {
  await fs.writeJson(workspaceSecretsPath(workspaceDir), normalizeWorkspaceSecrets(secrets), {
    spaces: 2,
  });
}

export async function saveWorkspaceGiteaToken(
  workspaceDir: string,
  token: string
): Promise<WorkspaceSecrets> {
  const secrets: WorkspaceSecrets = {
    ...(await readWorkspaceSecrets(workspaceDir)),
    giteaToken: token,
    schemaVersion: 1,
  };
  await writeWorkspaceSecrets(workspaceDir, secrets);
  return secrets;
}

export async function clearWorkspaceGiteaToken(workspaceDir: string): Promise<WorkspaceSecrets> {
  const secrets: WorkspaceSecrets = {
    ...(await readWorkspaceSecrets(workspaceDir)),
    schemaVersion: 1,
  };
  delete secrets.giteaToken;
  await writeWorkspaceSecrets(workspaceDir, secrets);
  return secrets;
}

function targetKey(target: WorkspaceTarget): string {
  return target.type === 'git'
    ? ['git', target.url, target.branch ?? ''].join('\0')
    : ['npm', target.spec].join('\0');
}

export async function addWorkspaceTarget(
  workspaceDir: string,
  target: WorkspaceTarget
): Promise<{ added: boolean; config: WorkspaceConfig }> {
  const config = await readWorkspaceConfig(workspaceDir);
  const id = targetKey(target);
  const exists = config.targets.some((existing) => targetKey(existing) === id);
  if (!exists) {
    config.targets.push(target);
    await writeWorkspaceConfig(workspaceDir, config);
  }

  return { added: !exists, config };
}

export async function removeWorkspaceTarget(
  workspaceDir: string,
  index: number
): Promise<{ config: WorkspaceConfig; removed: WorkspaceTarget }> {
  const config = await readWorkspaceConfig(workspaceDir);
  if (!Number.isInteger(index) || index < 1 || index > config.targets.length) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }

  const removed = config.targets.splice(index - 1, 1)[0];
  if (!removed) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }
  await writeWorkspaceConfig(workspaceDir, config);
  return { config, removed };
}

export function selectWorkspaceTargets(
  config: WorkspaceConfig,
  indexes: number[]
): SelectWorkspaceTargetsResult {
  const selectedIndexes: number[] = [];
  const selectedTargets: WorkspaceTarget[] = [];
  const seen = new Set<number>();

  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 1 || index > config.targets.length) {
      throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
    }
    if (seen.has(index)) {
      continue;
    }
    seen.add(index);
    selectedIndexes.push(index);
    const target = config.targets[index - 1];
    if (target) {
      selectedTargets.push(target);
    }
  }

  return {
    config: {
      ...config,
      targets: selectedTargets,
    },
    selectedIndexes,
    selectedTargets,
  };
}

export function createWorkspaceGitSources(config: WorkspaceConfig): GitSource[] {
  return config.targets
    .filter((target): target is WorkspaceGitTarget => target.type === 'git')
    .map((target) =>
      createGitSourceFromUrl({
        ...(target.branch ? { committish: target.branch } : {}),
        target: true,
        url: target.url,
      })
    );
}

export function createWorkspaceSnapshot(
  options: CreateWorkspaceSnapshotOptions
): WorkspaceSnapshot {
  const gitSourcesByUrl = new Map(
    createWorkspaceGitSources(options.config).map((source) => [source.sourceUrl, source])
  );

  return {
    createdAt: options.createdAt ?? new Date().toISOString(),
    output: options.config.output,
    schemaVersion: 1,
    sourceRegistry: options.config.sourceRegistry,
    targets: options.config.targets.map((target) => {
      if (target.type === 'npm') {
        return {
          spec: target.spec,
          type: 'npm',
        };
      }

      const source = gitSourcesByUrl.get(target.url.replace(/^git\+/, ''));
      if (!source) {
        throw new Error(`Unable to infer a Git source identity from ${target.url}`);
      }

      return {
        ...(target.branch ? { branch: target.branch } : {}),
        localMirrorPath: source.localMirrorPath,
        sourceId: source.id,
        type: 'git',
        url: target.url,
      };
    }),
  };
}
