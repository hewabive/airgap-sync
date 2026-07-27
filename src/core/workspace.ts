import path from 'node:path';
import * as fs from './fs.js';
import { semanticDigest } from './canonical-json.js';
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
import { isPythonResolutionMode, type PythonResolutionMode } from './python/resolution-policy.js';
import {
  normalizeInlinePlatformCoveragePolicy,
  normalizePlatformCoveragePolicy,
  platformCoveragePolicyDigest,
  type InlinePlatformCoveragePolicy,
  type PlatformCoveragePolicy,
} from './python/coverage-policy.js';
import type { PythonApplicationIntent, PythonRuntimePolicy } from './python/application-intent.js';
import { isValidPackageName, normalizePackageName } from './python/names.js';
import { isValidSpecifierSet } from './python/pep440.js';
import type { GitOwnerStrategy, GitPublishOwnerKind } from './git-publish-targets.js';
import { installMaintainedPythonApplicationRecipes } from './python/maintained-recipes.js';

export type { PythonResolutionMode } from './python/resolution-policy.js';

export const workspaceConfigFileName = 'airgap-sync.json';
export const workspaceSecretsFileName = 'airgap-sync.secrets.json';
export const defaultWorkspaceOutputDir = './airgap-bundle';
export const defaultWorkspaceSourceRegistry = 'https://registry.npmjs.org';
const defaultWorkspacePythonSourceIndex = 'https://pypi.org/simple/';
export const workspacePythonPlannerVersion = '0.11.16';

export interface WorkspaceGitTarget {
  branch?: string;
  pythonResolutionMode?: PythonResolutionMode;
  type: 'git';
  url: string;
}

export interface WorkspaceNpmTarget {
  spec: string;
  type: 'npm';
}

export interface WorkspacePypiTarget {
  pythonResolutionMode?: PythonResolutionMode;
  spec: string;
  type: 'pypi';
}

export interface WorkspacePythonWheelTarget {
  pythonResolutionMode?: PythonResolutionMode;
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

export interface WorkspacePythonApplicationTarget {
  application: {
    extras: string[];
    features: Record<string, string>;
    recipe?: string;
    version?: string;
  };
  coverage: InlinePlatformCoveragePolicy | string;
  python: PythonRuntimePolicy;
  spec: string;
  type: 'python-app';
}

export type WorkspaceTarget =
  | WorkspaceGitTarget
  | WorkspaceNpmTarget
  | WorkspacePypiTarget
  | WorkspacePythonApplicationTarget
  | WorkspacePythonWheelTarget
  | WorkspacePythonRuntimeTarget;
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

export interface WorkspacePythonLegacySeedConfig {
  resolutionMode: PythonResolutionMode;
  targetEnvironments?: PythonTargetEnvironmentConfig[];
}

export interface WorkspacePythonConfig {
  applicationArtifactOwner?: string;
  artifactTransfer?: {
    cpython: boolean;
    uv: boolean;
  };
  legacySeed?: WorkspacePythonLegacySeedConfig;
  planner: {
    engine: 'uv';
    version: typeof workspacePythonPlannerVersion;
  };
  publishOwner?: string;
  sourceIndex: string;
}

export interface WorkspaceLegacyPythonSettings {
  publishOwner?: string;
  resolutionMode: PythonResolutionMode;
  sourceIndex?: string;
  targetEnvironments?: PythonTargetEnvironmentConfig[];
}

export interface ResolvedWorkspacePythonApplication {
  coveragePolicy: PlatformCoveragePolicy;
  intent: PythonApplicationIntent;
  target: WorkspacePythonApplicationTarget;
}

export interface WorkspaceConfig {
  coveragePolicies?: PlatformCoveragePolicy[];
  defaults: WorkspaceDefaults;
  giteaUrl?: string;
  gitOwnerStrategy: GitOwnerStrategy;
  gitPublishOwner?: string;
  gitPublishOwnerKind?: GitPublishOwnerKind;
  output: string;
  pythonPublishOwner?: string;
  pythonResolutionMode?: PythonResolutionMode;
  pythonSourceIndex?: string;
  pythonTargetEnvironments?: PythonTargetEnvironmentConfig[];
  python?: WorkspacePythonConfig;
  schemaVersion: 1 | 2;
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
  pythonResolutionMode?: PythonResolutionMode;
  sourceId: string;
  type: 'git';
  url: string;
}

interface WorkspaceNpmTargetSnapshot {
  spec: string;
  type: 'npm';
}

interface WorkspacePypiTargetSnapshot {
  pythonResolutionMode?: PythonResolutionMode;
  spec: string;
  type: 'pypi';
}

interface WorkspacePythonWheelTargetSnapshot {
  pythonResolutionMode?: PythonResolutionMode;
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

interface WorkspacePythonApplicationTargetSnapshot extends WorkspacePythonApplicationTarget {}

export type WorkspaceTargetSnapshot =
  | WorkspaceGitTargetSnapshot
  | WorkspaceNpmTargetSnapshot
  | WorkspacePypiTargetSnapshot
  | WorkspacePythonApplicationTargetSnapshot
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
  python?: WorkspacePythonConfig;
  coveragePolicies?: PlatformCoveragePolicy[];
  schemaVersion: 1 | 2;
  sourceRegistry: string;
  targets: WorkspaceTargetSnapshot[];
}

export interface InitWorkspaceOptions {
  force?: boolean;
  legacy?: boolean;
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

function createDefaultWorkspaceConfig(legacy = false): WorkspaceConfig {
  if (!legacy) {
    return {
      coveragePolicies: [
        {
          id: 'desktop-x64',
          platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
          version: 1,
          wheelStrategy: 'all-compatible',
        },
      ],
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
      gitOwnerStrategy: 'preserve',
      output: defaultWorkspaceOutputDir,
      python: {
        applicationArtifactOwner: 'python-apps',
        planner: {
          engine: 'uv',
          version: workspacePythonPlannerVersion,
        },
        publishOwner: 'pypi',
        sourceIndex: defaultWorkspacePythonSourceIndex,
      },
      schemaVersion: 2,
      sourceRegistry: defaultWorkspaceSourceRegistry,
      targets: [],
    };
  }
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

function normalizeTargetPythonResolutionMode(
  value: unknown,
  targetType: 'git' | 'pypi' | 'python-wheel'
): PythonResolutionMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPythonResolutionMode(value)) {
    throw new Error(`${targetType} target pythonResolutionMode must be locked-only or approximate`);
  }
  return value;
}

export function workspaceConfigPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), workspaceConfigFileName);
}

export function workspaceSecretsPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), workspaceSecretsFileName);
}

function normalizePythonRuntimePolicy(value: unknown): PythonRuntimePolicy {
  if (value === undefined) {
    return { policy: 'auto' };
  }
  if (!isRecord(value) || (value.policy !== 'auto' && value.policy !== 'constrained')) {
    throw new Error('python-app target python policy must be auto or constrained');
  }
  if (value.policy === 'auto') {
    return { policy: 'auto' };
  }
  if (
    typeof value.version !== 'string' ||
    !value.version.trim() ||
    !isValidSpecifierSet(value.version.trim())
  ) {
    throw new Error('constrained python-app target requires a valid Python version specifier');
  }
  return {
    policy: 'constrained',
    version: value.version.trim(),
  };
}

function normalizeStringMap(value: unknown, description: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`${description} must be an object`);
  }
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawItem] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key || typeof rawItem !== 'string' || !rawItem.trim()) {
      throw new Error(`${description} keys and values must be non-empty strings`);
    }
    normalized[key] = rawItem.trim();
  }
  return normalized;
}

function normalizePythonApplicationTarget(
  value: Record<string, unknown>
): WorkspacePythonApplicationTarget {
  if (typeof value.spec !== 'string' || !value.spec.trim()) {
    throw new Error('python-app target must include a non-empty spec');
  }
  const parsed = parseRequirement(value.spec.trim());
  if (!parsed.ok || parsed.requirement.url || parsed.requirement.marker) {
    const reason = parsed.ok
      ? parsed.requirement.url
        ? 'direct URLs are not supported'
        : 'environment markers are not supported'
      : parsed.reason;
    throw new Error(`Invalid python-app target: ${reason}`);
  }

  const application = isRecord(value.application) ? value.application : {};
  const explicitVersion =
    typeof application.version === 'string' && application.version.trim()
      ? application.version.trim()
      : undefined;
  if (explicitVersion && parsed.requirement.specifier) {
    throw new Error(
      'python-app target version must be set either in spec or application.version, not both'
    );
  }
  const version = explicitVersion ?? (parsed.requirement.specifier || undefined);
  if (version && !isValidSpecifierSet(version)) {
    throw new Error('python-app application.version must be a valid version specifier');
  }

  let extras = parsed.requirement.extras;
  if (application.extras !== undefined) {
    if (
      !Array.isArray(application.extras) ||
      !application.extras.every(
        (extra): extra is string => typeof extra === 'string' && isValidPackageName(extra.trim())
      )
    ) {
      throw new Error('python-app application.extras must contain valid extra names');
    }
    extras = application.extras.map((extra) => normalizePackageName(extra.trim()));
  }
  extras = [...new Set(extras)].sort();

  let coverage: InlinePlatformCoveragePolicy | string;
  if (typeof value.coverage === 'string' && value.coverage.trim()) {
    coverage = value.coverage.trim();
  } else {
    coverage = normalizeInlinePlatformCoveragePolicy(value.coverage);
  }

  return {
    application: {
      extras,
      features: normalizeStringMap(application.features, 'python-app application.features'),
      ...(typeof application.recipe === 'string' && application.recipe.trim()
        ? { recipe: application.recipe.trim() }
        : {}),
      ...(version ? { version } : {}),
    },
    coverage,
    python: normalizePythonRuntimePolicy(value.python),
    spec: parsed.requirement.normalizedName,
    type: 'python-app',
  };
}

function normalizeWorkspaceTarget(value: unknown): WorkspaceTarget {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Workspace target must be an object with a type');
  }

  if (value.type === 'git') {
    if (typeof value.url !== 'string' || value.url.trim().length === 0) {
      throw new Error('Git target must include a non-empty url');
    }

    const pythonResolutionMode = normalizeTargetPythonResolutionMode(
      value.pythonResolutionMode,
      'git'
    );
    return {
      ...(typeof value.branch === 'string' && value.branch.trim().length > 0
        ? { branch: value.branch.trim() }
        : {}),
      ...(pythonResolutionMode ? { pythonResolutionMode } : {}),
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
    if (value.type === 'pypi') {
      const pythonResolutionMode = normalizeTargetPythonResolutionMode(
        value.pythonResolutionMode,
        'pypi'
      );
      return {
        ...(pythonResolutionMode ? { pythonResolutionMode } : {}),
        spec: value.spec.trim(),
        type: 'pypi',
      };
    }
    return { spec: value.spec.trim(), type: 'npm' };
  }

  if (value.type === 'python-app') {
    return normalizePythonApplicationTarget(value);
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
    const pythonResolutionMode = normalizeTargetPythonResolutionMode(
      value.pythonResolutionMode,
      'python-wheel'
    );
    return {
      ...(pythonResolutionMode ? { pythonResolutionMode } : {}),
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

function normalizeCoveragePolicies(value: unknown): PlatformCoveragePolicy[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('coveragePolicies must be an array');
  }
  const policies = value.map(normalizePlatformCoveragePolicy);
  const ids = new Set<string>();
  for (const policy of policies) {
    if (ids.has(policy.id)) {
      throw new Error(`Duplicate coverage policy id: ${policy.id}`);
    }
    ids.add(policy.id);
  }
  return policies;
}

function normalizeWorkspacePythonConfig(value: unknown): WorkspacePythonConfig {
  if (!isRecord(value)) {
    throw new Error('python settings must be an object');
  }
  const sourceIndex = normalizeHttpUrl(
    optionalString(value.sourceIndex) ?? defaultWorkspacePythonSourceIndex,
    'python.sourceIndex'
  );
  const publishOwner = optionalString(value.publishOwner);
  const applicationArtifactOwner = optionalString(value.applicationArtifactOwner);
  let artifactTransfer: WorkspacePythonConfig['artifactTransfer'];
  if (value.artifactTransfer !== undefined) {
    if (!isRecord(value.artifactTransfer)) {
      throw new Error('python.artifactTransfer must be an object');
    }
    artifactTransfer = {
      cpython: value.artifactTransfer.cpython === true,
      uv: value.artifactTransfer.uv === true,
    };
    if ((artifactTransfer.cpython || artifactTransfer.uv) && !applicationArtifactOwner) {
      throw new Error('python.artifactTransfer requires python.applicationArtifactOwner');
    }
  }
  const planner = isRecord(value.planner) ? value.planner : {};
  if (planner.engine !== undefined && planner.engine !== 'uv') {
    throw new Error('python.planner.engine must be uv');
  }
  if (
    planner.version !== undefined &&
    planner.version !== workspacePythonPlannerVersion &&
    planner.version !== 'pinned-by-airgap-sync'
  ) {
    throw new Error(
      `python.planner.version must use the airgap-sync pin (${workspacePythonPlannerVersion})`
    );
  }

  let legacySeed: WorkspacePythonLegacySeedConfig | undefined;
  if (value.legacySeed !== undefined) {
    if (!isRecord(value.legacySeed)) {
      throw new Error('python.legacySeed must be an object');
    }
    const targetEnvironments = normalizePythonTargetEnvironments(
      value.legacySeed.targetEnvironments
    );
    const resolutionMode: PythonResolutionMode =
      value.legacySeed.resolutionMode === 'approximate' ? 'approximate' : 'locked-only';
    legacySeed = {
      resolutionMode,
      ...(targetEnvironments ? { targetEnvironments } : {}),
    };
  }

  return {
    ...(applicationArtifactOwner ? { applicationArtifactOwner } : {}),
    ...(artifactTransfer ? { artifactTransfer } : {}),
    ...(legacySeed ? { legacySeed } : {}),
    planner: {
      engine: 'uv',
      version: workspacePythonPlannerVersion,
    },
    ...(publishOwner ? { publishOwner } : {}),
    sourceIndex,
  };
}

function normalizeWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (!isRecord(value)) {
    throw new Error(`${workspaceConfigFileName} must contain a JSON object`);
  }

  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error(`${workspaceConfigFileName} schemaVersion must be 1 or 2`);
  }

  const schemaVersion = value.schemaVersion;
  const coveragePolicies =
    schemaVersion === 2 ? normalizeCoveragePolicies(value.coveragePolicies) : [];
  const targets = Array.isArray(value.targets)
    ? value.targets.map((target) => normalizeWorkspaceTarget(target))
    : [];
  if (schemaVersion === 1 && targets.some((target) => target.type === 'python-app')) {
    throw new Error('python-app targets require workspace schemaVersion 2');
  }
  const coveragePolicyIds = new Set(coveragePolicies.map((policy) => policy.id));
  for (const target of targets) {
    if (
      target.type === 'python-app' &&
      typeof target.coverage === 'string' &&
      !coveragePolicyIds.has(target.coverage)
    ) {
      throw new Error(`python-app target references unknown coverage policy: ${target.coverage}`);
    }
  }

  const giteaUrl = optionalString(value.giteaUrl);
  const targetRegistry = optionalString(value.targetRegistry);
  const pythonTargetEnvironments =
    schemaVersion === 1
      ? normalizePythonTargetEnvironments(value.pythonTargetEnvironments)
      : undefined;
  const pythonSourceIndexValue =
    schemaVersion === 1 ? optionalString(value.pythonSourceIndex) : undefined;
  const pythonSourceIndex =
    schemaVersion === 1
      ? pythonTargetEnvironments
        ? normalizeHttpUrl(
            pythonSourceIndexValue ?? defaultWorkspacePythonSourceIndex,
            'pythonSourceIndex'
          )
        : pythonSourceIndexValue
          ? normalizeHttpUrl(pythonSourceIndexValue, 'pythonSourceIndex')
          : undefined
      : undefined;
  const pythonPublishOwner =
    schemaVersion === 1 ? optionalString(value.pythonPublishOwner) : undefined;
  const pythonResolutionMode: PythonResolutionMode | undefined =
    schemaVersion === 1
      ? value.pythonResolutionMode === 'approximate'
        ? 'approximate'
        : 'locked-only'
      : undefined;
  const python =
    schemaVersion === 2 &&
    (value.python !== undefined ||
      targets.some(
        (target) =>
          target.type === 'python-app' || target.type === 'pypi' || target.type === 'python-wheel'
      ))
      ? normalizeWorkspacePythonConfig(value.python ?? {})
      : undefined;
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
    !(schemaVersion === 1 ? pythonTargetEnvironments : python?.legacySeed?.targetEnvironments)
      ?.length
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
    ...(pythonResolutionMode ? { pythonResolutionMode } : {}),
    ...(pythonSourceIndex ? { pythonSourceIndex } : {}),
    ...(pythonTargetEnvironments ? { pythonTargetEnvironments } : {}),
    ...(python ? { python } : {}),
    ...(schemaVersion === 2 ? { coveragePolicies } : {}),
    schemaVersion,
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

  const config = createDefaultWorkspaceConfig(options.legacy === true);
  await fs.writeJson(configPath, config, { spaces: 2 });
  await fs.ensureDir(path.resolve(workspaceDir, config.output));
  if (config.schemaVersion === 2) {
    await installMaintainedPythonApplicationRecipes(workspaceDir);
  }
  return config;
}

export async function readWorkspaceConfig(workspaceDir: string): Promise<WorkspaceConfig> {
  return normalizeWorkspaceConfig(await fs.readJson(workspaceConfigPath(workspaceDir)));
}

export function workspaceLegacyPythonSettings(
  config: WorkspaceConfig
): WorkspaceLegacyPythonSettings {
  if (config.schemaVersion === 2) {
    return {
      ...(config.python?.publishOwner ? { publishOwner: config.python.publishOwner } : {}),
      resolutionMode: config.python?.legacySeed?.resolutionMode ?? 'locked-only',
      ...(config.python?.sourceIndex ? { sourceIndex: config.python.sourceIndex } : {}),
      ...(config.python?.legacySeed?.targetEnvironments
        ? { targetEnvironments: config.python.legacySeed.targetEnvironments }
        : {}),
    };
  }
  return {
    ...(config.pythonPublishOwner ? { publishOwner: config.pythonPublishOwner } : {}),
    resolutionMode: config.pythonResolutionMode ?? 'locked-only',
    ...(config.pythonSourceIndex ? { sourceIndex: config.pythonSourceIndex } : {}),
    ...(config.pythonTargetEnvironments
      ? { targetEnvironments: config.pythonTargetEnvironments }
      : {}),
  };
}

export function withWorkspaceLegacyPythonSettings(
  config: WorkspaceConfig,
  settings: WorkspaceLegacyPythonSettings
): WorkspaceConfig {
  if (config.schemaVersion === 1) {
    const nextConfig: WorkspaceConfig = {
      ...config,
      ...(settings.publishOwner ? { pythonPublishOwner: settings.publishOwner } : {}),
      pythonResolutionMode: settings.resolutionMode,
      ...(settings.sourceIndex ? { pythonSourceIndex: settings.sourceIndex } : {}),
    };
    if (settings.targetEnvironments) {
      nextConfig.pythonTargetEnvironments = settings.targetEnvironments;
    } else {
      delete nextConfig.pythonTargetEnvironments;
    }
    return nextConfig;
  }

  return {
    ...config,
    python: {
      ...(config.python?.applicationArtifactOwner
        ? { applicationArtifactOwner: config.python.applicationArtifactOwner }
        : {}),
      ...(config.python?.artifactTransfer
        ? { artifactTransfer: config.python.artifactTransfer }
        : {}),
      legacySeed: {
        resolutionMode: settings.resolutionMode,
        ...(settings.targetEnvironments ? { targetEnvironments: settings.targetEnvironments } : {}),
      },
      planner: config.python?.planner ?? {
        engine: 'uv',
        version: workspacePythonPlannerVersion,
      },
      ...(settings.publishOwner ? { publishOwner: settings.publishOwner } : {}),
      sourceIndex:
        settings.sourceIndex ?? config.python?.sourceIndex ?? defaultWorkspacePythonSourceIndex,
    },
  };
}

export function resolveWorkspacePythonApplication(
  config: WorkspaceConfig,
  target: WorkspacePythonApplicationTarget
): ResolvedWorkspacePythonApplication {
  if (config.schemaVersion !== 2) {
    throw new Error('python-app targets require workspace schemaVersion 2');
  }
  const parsed = parseRequirement(target.spec);
  if (!parsed.ok || parsed.requirement.url || parsed.requirement.marker) {
    throw new Error(`Invalid python-app target: ${target.spec}`);
  }
  const coveragePolicy =
    typeof target.coverage === 'string'
      ? config.coveragePolicies?.find((policy) => policy.id === target.coverage)
      : {
          id: `inline-${platformCoveragePolicyDigest(target.coverage).slice(0, 12)}`,
          ...target.coverage,
        };
  if (!coveragePolicy) {
    throw new Error(`Unknown coverage policy: ${target.coverage as string}`);
  }
  return {
    coveragePolicy,
    intent: {
      application: {
        extras: target.application.extras,
        features: target.application.features,
        name: parsed.requirement.normalizedName,
        ...(target.application.recipe ? { recipe: target.application.recipe } : {}),
        ...(target.application.version ? { version: target.application.version } : {}),
      },
      coverage:
        typeof target.coverage === 'string'
          ? { policyId: target.coverage }
          : { inline: target.coverage },
      python: target.python,
      source: {
        ...(config.python?.sourceIndex ? { indexUrl: config.python.sourceIndex } : {}),
        type: 'pypi',
      },
      updatePolicy: 'manual',
    },
    target,
  };
}

export function previewWorkspaceConfigMigration(config: WorkspaceConfig): WorkspaceConfig {
  const normalized = normalizeWorkspaceConfig(config);
  if (normalized.schemaVersion === 2) {
    return normalized;
  }

  const {
    pythonPublishOwner,
    pythonResolutionMode,
    pythonSourceIndex,
    pythonTargetEnvironments,
    ...common
  } = normalized;
  const hasLegacyPythonIntent =
    pythonPublishOwner !== undefined ||
    pythonSourceIndex !== undefined ||
    pythonTargetEnvironments !== undefined ||
    normalized.targets.some(
      (target) => target.type === 'git' || target.type === 'pypi' || target.type === 'python-wheel'
    );
  const migrated: WorkspaceConfig = {
    ...common,
    coveragePolicies: [],
    ...(hasLegacyPythonIntent
      ? {
          python: {
            legacySeed: {
              resolutionMode: pythonResolutionMode ?? 'locked-only',
              ...(pythonTargetEnvironments ? { targetEnvironments: pythonTargetEnvironments } : {}),
            },
            planner: {
              engine: 'uv',
              version: workspacePythonPlannerVersion,
            },
            ...(pythonPublishOwner ? { publishOwner: pythonPublishOwner } : {}),
            sourceIndex: pythonSourceIndex ?? defaultWorkspacePythonSourceIndex,
          },
        }
      : {}),
    schemaVersion: 2,
  };
  return normalizeWorkspaceConfig(migrated);
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
  await fs.writeJson(workspaceConfigPath(workspaceDir), normalizeWorkspaceConfig(config), {
    spaces: 2,
  });
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
    : target.type === 'python-app'
      ? [
          target.type,
          target.spec,
          semanticDigest({
            application: target.application,
            coverage: target.coverage,
            python: target.python,
          }),
        ].join('\0')
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
    !(
      config.schemaVersion === 1
        ? config.pythonTargetEnvironments
        : config.python?.legacySeed?.targetEnvironments
    )?.length
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

export async function setWorkspaceTargetPythonResolutionMode(
  workspaceDir: string,
  index: number,
  pythonResolutionMode: PythonResolutionMode | undefined
): Promise<{ config: WorkspaceConfig; target: WorkspaceTarget }> {
  const config = await readWorkspaceConfig(workspaceDir);
  if (!Number.isInteger(index) || index < 1 || index > config.targets.length) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }
  const target = config.targets[index - 1];
  if (!target) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }
  if (target.type !== 'git' && target.type !== 'pypi' && target.type !== 'python-wheel') {
    throw new Error(`${target.type} targets do not resolve Python dependencies`);
  }
  if (pythonResolutionMode) {
    target.pythonResolutionMode = pythonResolutionMode;
  } else {
    delete target.pythonResolutionMode;
  }
  await writeWorkspaceConfig(workspaceDir, config);
  return { config, target };
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
        ...(target.pythonResolutionMode
          ? { pythonResolutionMode: target.pythonResolutionMode }
          : {}),
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
        ...(target.pythonResolutionMode
          ? { pythonResolutionMode: target.pythonResolutionMode }
          : {}),
        requiredBy: 'root',
        requirement: parsed.requirement,
        sourcePath: 'workspace-targets',
      },
    ];
  });
}

export function createWorkspacePythonRootWheels(config: WorkspaceConfig): PythonRootWheelInput[] {
  return config.targets.flatMap((target, index) =>
    target.type === 'python-wheel'
      ? [
          {
            line: index + 1,
            ...(target.pythonResolutionMode
              ? { pythonResolutionMode: target.pythonResolutionMode }
              : {}),
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
  const legacyPython = workspaceLegacyPythonSettings(options.config);
  const hasLegacyPython =
    options.config.schemaVersion === 1 || options.config.python?.legacySeed !== undefined;

  return {
    createdAt: options.createdAt ?? new Date().toISOString(),
    gitOwnerStrategy: options.config.gitOwnerStrategy,
    ...(options.config.gitPublishOwner ? { gitPublishOwner: options.config.gitPublishOwner } : {}),
    ...(options.config.gitPublishOwnerKind
      ? { gitPublishOwnerKind: options.config.gitPublishOwnerKind }
      : {}),
    output: options.config.output,
    ...(hasLegacyPython && legacyPython.publishOwner
      ? { pythonPublishOwner: legacyPython.publishOwner }
      : {}),
    ...(hasLegacyPython ? { pythonResolutionMode: legacyPython.resolutionMode } : {}),
    ...(hasLegacyPython && legacyPython.sourceIndex
      ? { pythonSourceIndex: legacyPython.sourceIndex }
      : {}),
    ...(legacyPython.targetEnvironments
      ? { pythonTargetEnvironments: legacyPython.targetEnvironments }
      : {}),
    ...(options.config.python ? { python: options.config.python } : {}),
    ...(options.config.coveragePolicies
      ? { coveragePolicies: options.config.coveragePolicies }
      : {}),
    schemaVersion: options.config.schemaVersion,
    sourceRegistry: options.config.sourceRegistry,
    targets: options.config.targets.map((target) => {
      if (target.type === 'npm') {
        return {
          spec: target.spec,
          type: target.type,
        };
      }

      if (target.type === 'pypi') {
        return {
          ...(target.pythonResolutionMode
            ? { pythonResolutionMode: target.pythonResolutionMode }
            : {}),
          spec: target.spec,
          type: target.type,
        };
      }

      if (target.type === 'python-wheel') {
        return {
          ...(target.pythonResolutionMode
            ? { pythonResolutionMode: target.pythonResolutionMode }
            : {}),
          sha256: target.sha256,
          type: target.type,
          url: target.url,
        };
      }

      if (target.type === 'python-runtime') {
        return {
          pythonVersion: target.pythonVersion,
          sha256: target.sha256,
          type: target.type,
          url: target.url,
        };
      }

      if (target.type === 'python-app') {
        return {
          application: target.application,
          coverage: target.coverage,
          python: target.python,
          spec: target.spec,
          type: target.type,
        };
      }

      const source = gitSourcesByUrl.get(target.url.replace(/^git\+/, ''));
      if (!source) {
        throw new Error(`Unable to infer a Git source identity from ${target.url}`);
      }

      return {
        ...(target.branch ? { branch: target.branch } : {}),
        localMirrorPath: source.localMirrorPath,
        ...(target.pythonResolutionMode
          ? { pythonResolutionMode: target.pythonResolutionMode }
          : {}),
        sourceId: source.id,
        type: 'git',
        url: target.url,
      };
    }),
  };
}
