import path from 'node:path';
import * as fs from './fs.js';
import { createGitSourceFromUrl } from './git-sources.js';
import type {
  GitSource,
  LatestPolicy,
  RangeResolutionPolicy,
  TagResolutionPolicy,
} from '../types.js';
import {
  resolveTargetEnvironment,
  type PythonTargetArch,
  type PythonTargetEnvironmentConfig,
  type PythonTargetOs,
} from './python/environments.js';
import { parseRequirement } from './python/requirements.js';
import type { PythonRequirementInput } from './python/input-types.js';
import type { PythonRootWheelInput } from './python/input-types.js';
import type { PythonRuntimeArtifactInput } from './python/runtime-artifacts.js';
import type { GitOwnerStrategy, GitPublishOwnerKind } from './git-publish-targets.js';

export const workspaceConfigFileName = 'airgap-sync.json';
export const workspaceSecretsFileName = 'airgap-sync.secrets.json';
export const defaultWorkspaceOutputDir = './airgap-bundle';
export const defaultWorkspaceSourceRegistry = 'https://registry.npmjs.org';
const defaultWorkspacePythonSourceIndex = 'https://pypi.org/simple/';

export interface WorkspaceGitTarget {
  branch?: string;
  type: 'git';
  url: string;
}

export interface WorkspaceNpmTarget {
  spec: string;
  type: 'npm';
}

interface WorkspacePypiTarget {
  spec: string;
  type: 'pypi';
}

export interface WorkspacePythonWheelTarget {
  sha256: string;
  type: 'python-wheel';
  url: string;
}

export interface WorkspacePythonRuntimeTarget {
  pythonVersion: string;
  sha256: string;
  type: 'python-runtime';
  url: string;
}

export type WorkspaceTarget =
  | WorkspaceGitTarget
  | WorkspaceNpmTarget
  | WorkspacePypiTarget
  | WorkspacePythonWheelTarget
  | WorkspacePythonRuntimeTarget;
export type WorkspacePromptBoolean = boolean | 'ask';
export type PythonResolutionMode = 'approximate' | 'locked-only';

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
  gitOwnerStrategy: GitOwnerStrategy;
  gitPublishOwner?: string;
  gitPublishOwnerKind?: GitPublishOwnerKind;
  output: string;
  pythonPublishOwner?: string;
  pythonResolutionMode: PythonResolutionMode;
  pythonSourceIndex?: string;
  pythonTargetEnvironments?: PythonTargetEnvironmentConfig[];
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

interface WorkspacePypiTargetSnapshot {
  spec: string;
  type: 'pypi';
}

interface WorkspacePythonWheelTargetSnapshot {
  sha256: string;
  type: 'python-wheel';
  url: string;
}

interface WorkspacePythonRuntimeTargetSnapshot {
  pythonVersion: string;
  sha256: string;
  type: 'python-runtime';
  url: string;
}

export type WorkspaceTargetSnapshot =
  | WorkspaceGitTargetSnapshot
  | WorkspaceNpmTargetSnapshot
  | WorkspacePypiTargetSnapshot
  | WorkspacePythonWheelTargetSnapshot
  | WorkspacePythonRuntimeTargetSnapshot;

export interface WorkspaceSnapshot {
  createdAt: string;
  gitOwnerStrategy?: GitOwnerStrategy;
  gitPublishOwner?: string;
  gitPublishOwnerKind?: GitPublishOwnerKind;
  output: string;
  pythonPublishOwner?: string;
  pythonResolutionMode?: PythonResolutionMode;
  pythonSourceIndex?: string;
  pythonTargetEnvironments?: PythonTargetEnvironmentConfig[];
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
    pythonResolutionMode: 'locked-only',
    gitOwnerStrategy: 'preserve',
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

  if (value.type === 'npm' || value.type === 'pypi') {
    if (typeof value.spec !== 'string' || value.spec.trim().length === 0) {
      throw new Error(`${value.type} target must include a non-empty spec`);
    }

    if (value.type === 'pypi') {
      const parsed = parseRequirement(value.spec.trim());
      if (!parsed.ok || parsed.requirement.url) {
        throw new Error(
          `Invalid pypi target: ${parsed.ok ? 'direct URLs are not supported' : parsed.reason}`
        );
      }
    }
    return {
      spec: value.spec.trim(),
      type: value.type,
    };
  }

  if (value.type === 'python-wheel') {
    if (typeof value.url !== 'string' || !value.url.trim()) {
      throw new Error('python-wheel target must include a non-empty url');
    }
    const url = new URL(value.url.trim());
    if (!['file:', 'http:', 'https:'].includes(url.protocol)) {
      throw new Error('python-wheel target URL must use file, HTTP, or HTTPS');
    }
    if (url.username || url.password) {
      throw new Error('python-wheel target URL must not contain credentials');
    }
    if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256.trim())) {
      throw new Error('python-wheel target must include a 64-character SHA-256');
    }
    return {
      sha256: value.sha256.trim().toLowerCase(),
      type: 'python-wheel',
      url: url.toString(),
    };
  }

  if (value.type === 'python-runtime') {
    if (typeof value.url !== 'string' || !value.url.trim()) {
      throw new Error('python-runtime target must include a non-empty url');
    }
    const url = new URL(value.url.trim());
    if (!['file:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('python-runtime target URL must be credential-free file, HTTP, or HTTPS');
    }
    if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256.trim())) {
      throw new Error('python-runtime target must include a 64-character SHA-256');
    }
    if (
      typeof value.pythonVersion !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(value.pythonVersion.trim())
    ) {
      throw new Error('python-runtime target requires a full X.Y.Z pythonVersion');
    }
    return {
      pythonVersion: value.pythonVersion.trim(),
      sha256: value.sha256.trim().toLowerCase(),
      type: 'python-runtime',
      url: url.toString(),
    };
  }

  throw new Error(`Unsupported workspace target type: ${value.type}`);
}

const pythonTargetOs = new Set<PythonTargetOs>(['linux', 'macos', 'windows']);
const pythonTargetArch = new Set<PythonTargetArch>([
  'aarch64',
  'arm64',
  'i686',
  'ppc64le',
  's390x',
  'x86_64',
]);

function normalizePythonTargetEnvironment(value: unknown): PythonTargetEnvironmentConfig {
  if (!isRecord(value)) {
    throw new Error('Python target environment must be an object');
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error('Python target environment must have a non-empty name');
  }
  if (typeof value.pythonVersion !== 'string') {
    throw new Error(`Python target environment ${value.name} must have pythonVersion`);
  }
  if (typeof value.os !== 'string' || !pythonTargetOs.has(value.os as PythonTargetOs)) {
    throw new Error(`Python target environment ${value.name} has unsupported os`);
  }
  if (typeof value.arch !== 'string' || !pythonTargetArch.has(value.arch as PythonTargetArch)) {
    throw new Error(`Python target environment ${value.name} has unsupported arch`);
  }
  const markerOverrides = isRecord(value.markerOverrides)
    ? {
        ...(typeof value.markerOverrides.platformRelease === 'string'
          ? { platformRelease: value.markerOverrides.platformRelease }
          : {}),
        ...(typeof value.markerOverrides.platformVersion === 'string'
          ? { platformVersion: value.markerOverrides.platformVersion }
          : {}),
      }
    : undefined;
  const config: PythonTargetEnvironmentConfig = {
    arch: value.arch as PythonTargetArch,
    name: value.name.trim(),
    os: value.os as PythonTargetOs,
    pythonVersion: value.pythonVersion.trim(),
    ...(typeof value.macosVersion === 'string' ? { macosVersion: value.macosVersion.trim() } : {}),
    ...(typeof value.manylinux === 'string' ? { manylinux: value.manylinux.trim() } : {}),
    ...(typeof value.musllinux === 'string' ? { musllinux: value.musllinux.trim() } : {}),
    ...(Array.isArray(value.platformTags) &&
    value.platformTags.every((item): item is string => typeof item === 'string')
      ? { platformTags: [...value.platformTags] }
      : {}),
    ...(markerOverrides && Object.keys(markerOverrides).length > 0 ? { markerOverrides } : {}),
  };
  resolveTargetEnvironment(config);
  return config;
}

function normalizePythonTargetEnvironments(
  value: unknown
): PythonTargetEnvironmentConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('pythonTargetEnvironments must be a non-empty array when provided');
  }
  const environments = value.map(normalizePythonTargetEnvironment);
  const names = new Set<string>();
  for (const environment of environments) {
    if (names.has(environment.name)) {
      throw new Error(`Duplicate Python target environment name: ${environment.name}`);
    }
    names.add(environment.name);
  }
  return environments;
}

function normalizeHttpUrl(value: string, description: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${description} must use HTTP or HTTPS`);
  }
  return parsed.toString();
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
  const pythonTargetEnvironments = normalizePythonTargetEnvironments(
    value.pythonTargetEnvironments
  );
  const pythonSourceIndexValue = optionalString(value.pythonSourceIndex);
  const pythonSourceIndex = pythonTargetEnvironments
    ? normalizeHttpUrl(
        pythonSourceIndexValue ?? defaultWorkspacePythonSourceIndex,
        'pythonSourceIndex'
      )
    : pythonSourceIndexValue
      ? normalizeHttpUrl(pythonSourceIndexValue, 'pythonSourceIndex')
      : undefined;
  const pythonPublishOwner = optionalString(value.pythonPublishOwner);
  const pythonResolutionMode: PythonResolutionMode =
    value.pythonResolutionMode === 'approximate' ? 'approximate' : 'locked-only';
  const gitOwnerStrategy: GitOwnerStrategy =
    value.gitOwnerStrategy === 'authenticated-user' || value.gitOwnerStrategy === 'fixed-owner'
      ? value.gitOwnerStrategy
      : 'preserve';
  const gitPublishOwner = optionalString(value.gitPublishOwner);
  const gitPublishOwnerKind: GitPublishOwnerKind | undefined =
    value.gitPublishOwnerKind === 'user' || value.gitPublishOwnerKind === 'organization'
      ? value.gitPublishOwnerKind
      : undefined;
  if (gitOwnerStrategy === 'fixed-owner' && (!gitPublishOwner || !gitPublishOwnerKind)) {
    throw new Error(
      'fixed-owner gitOwnerStrategy requires gitPublishOwner and gitPublishOwnerKind'
    );
  }
  if (
    targets.some((target) => target.type === 'pypi' || target.type === 'python-wheel') &&
    (!pythonTargetEnvironments || pythonTargetEnvironments.length === 0)
  ) {
    throw new Error('pypi targets require pythonTargetEnvironments');
  }

  return {
    defaults: normalizeWorkspaceDefaults(value.defaults),
    ...(giteaUrl ? { giteaUrl } : {}),
    gitOwnerStrategy,
    ...(gitPublishOwner ? { gitPublishOwner } : {}),
    ...(gitPublishOwnerKind ? { gitPublishOwnerKind } : {}),
    output:
      typeof value.output === 'string' && value.output.trim().length > 0
        ? value.output.trim()
        : defaultWorkspaceOutputDir,
    ...(pythonPublishOwner ? { pythonPublishOwner } : {}),
    pythonResolutionMode,
    ...(pythonSourceIndex ? { pythonSourceIndex } : {}),
    ...(pythonTargetEnvironments ? { pythonTargetEnvironments } : {}),
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
    : target.type === 'python-wheel' || target.type === 'python-runtime'
      ? [target.type, target.url, target.sha256].join('\0')
      : [target.type, target.spec].join('\0');
}

export async function addWorkspaceTarget(
  workspaceDir: string,
  target: WorkspaceTarget
): Promise<{ added: boolean; config: WorkspaceConfig }> {
  const config = await readWorkspaceConfig(workspaceDir);
  if (
    (target.type === 'pypi' || target.type === 'python-wheel') &&
    !config.pythonTargetEnvironments?.length
  ) {
    throw new Error('pypi targets require pythonTargetEnvironments');
  }
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

export function createWorkspacePythonRequirements(
  config: WorkspaceConfig
): PythonRequirementInput[] {
  return config.targets.flatMap((target, index) => {
    if (target.type !== 'pypi') {
      return [];
    }
    const parsed = parseRequirement(target.spec);
    if (!parsed.ok || parsed.requirement.url) {
      throw new Error(`Invalid pypi target at index ${String(index + 1)}: ${target.spec}`);
    }
    return [
      {
        constraint: false,
        hashes: [],
        line: index + 1,
        requiredBy: 'root',
        requirement: parsed.requirement,
        sourcePath: 'workspace-targets',
      },
    ];
  });
}

export function createWorkspacePythonRootWheels(
  config: WorkspaceConfig
): PythonRootWheelInput[] {
  return config.targets.flatMap((target, index) =>
    target.type === 'python-wheel'
      ? [
          {
            line: index + 1,
            requiredBy: 'root',
            sha256: target.sha256,
            sourcePath: 'workspace-wheel-targets',
            url: target.url,
          },
        ]
      : []
  );
}

export function createWorkspacePythonRuntimeArtifacts(
  config: WorkspaceConfig
): PythonRuntimeArtifactInput[] {
  return config.targets.flatMap((target) =>
    target.type === 'python-runtime'
      ? [
          {
            pythonVersion: target.pythonVersion,
            sha256: target.sha256,
            url: target.url,
          },
        ]
      : []
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
    gitOwnerStrategy: options.config.gitOwnerStrategy,
    ...(options.config.gitPublishOwner
      ? { gitPublishOwner: options.config.gitPublishOwner }
      : {}),
    ...(options.config.gitPublishOwnerKind
      ? { gitPublishOwnerKind: options.config.gitPublishOwnerKind }
      : {}),
    output: options.config.output,
    ...(options.config.pythonPublishOwner
      ? { pythonPublishOwner: options.config.pythonPublishOwner }
      : {}),
    pythonResolutionMode: options.config.pythonResolutionMode,
    ...(options.config.pythonSourceIndex
      ? { pythonSourceIndex: options.config.pythonSourceIndex }
      : {}),
    ...(options.config.pythonTargetEnvironments
      ? { pythonTargetEnvironments: options.config.pythonTargetEnvironments }
      : {}),
    schemaVersion: 1,
    sourceRegistry: options.config.sourceRegistry,
    targets: options.config.targets.map((target) => {
      if (target.type === 'npm' || target.type === 'pypi') {
        return {
          spec: target.spec,
          type: target.type,
        };
      }

      if (target.type === 'python-wheel') {
        return { sha256: target.sha256, type: target.type, url: target.url };
      }

      if (target.type === 'python-runtime') {
        return {
          pythonVersion: target.pythonVersion,
          sha256: target.sha256,
          type: target.type,
          url: target.url,
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
