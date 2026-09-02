import path from 'node:path';
import * as fs from './fs.js';
import { semanticDigest } from './canonical-json.js';
import { createGitSourceFromUrl } from './git-sources.js';
import type {
  GitSource,
  LatestPolicy,
  NpmSecurityPolicy,
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
import {
  normalizeInlinePlatformCoveragePolicy,
  normalizePlatformCoveragePolicy,
  platformCoveragePolicyDigest,
  type InlinePlatformCoveragePolicy,
  type PlatformCoveragePolicy,
} from './python/coverage-policy.js';
import type {
  PythonApplicationIntent,
  PythonApplicationVersionSelection,
  PythonApplicationVersionSelector,
  PythonRuntimePolicy,
} from './python/application-intent.js';
import { initialPythonApplicationMinors } from './python/application-intent.js';
import { isValidPackageName, normalizePackageName } from './python/names.js';
import { isValidSpecifierSet, normalizeVersion } from './python/pep440.js';
import type { GitOwnerStrategy, GitPublishOwnerKind } from './git-publish-targets.js';
import { installMaintainedPythonApplicationRecipes } from './python/maintained-recipes.js';
import {
  defaultPythonPublicationProfile,
  normalizePythonPublicationProfile,
  type PythonPublicationProfile,
} from './python/publication-targets.js';
import {
  isBuiltInPlatformFamilyId,
  type BuiltInPlatformFamilyId,
} from './python/platform-family.js';
import { normalizeNpmRegistryTarget, type NpmRegistryTarget } from './npm-publication-targets.js';

export const workspaceConfigFileName = 'airgap-sync.json';
export const workspaceConfigV1BackupFileName = `${workspaceConfigFileName}.v1.backup`;
export const workspaceConfigPythonPublicationBackupFileName = `${workspaceConfigFileName}.before-0002-python-publication.backup`;
export const workspaceConfigPythonPublicationProfileBackupFileName = `${workspaceConfigFileName}.before-0003-python-publication-profile.backup`;
export const workspaceConfigNpmRegistryTargetBackupFileName = `${workspaceConfigFileName}.before-0004-npm-registry-target.backup`;
export const workspaceSecretsFileName = 'airgap-sync.secrets.json';
export const defaultWorkspaceOutputDir = './airgap-bundle';
export const defaultWorkspaceSourceRegistry = 'https://registry.npmjs.org';
export const defaultWorkspaceGiteaUrl = 'http://127.0.0.1:3000';
const defaultWorkspacePythonSourceIndex = 'https://pypi.org/simple/';
const defaultWorkspacePythonApplicationArtifactOwner = 'python-apps';
const defaultWorkspacePythonPublishOwner = 'pypi';
export const workspacePythonPlannerVersion = '0.11.16';

export interface WorkspaceTargetState {
  paused?: boolean;
}

export interface WorkspaceGitTarget extends WorkspaceTargetState {
  branch?: string;
  type: 'git';
  url: string;
}

export interface WorkspaceNpmTarget extends WorkspaceTargetState {
  spec: string;
  type: 'npm';
}

export interface WorkspaceCpythonDistributionsTarget extends WorkspaceTargetState {
  builds: {
    windowDays: number;
  };
  patches: {
    latest: number;
  };
  platforms: BuiltInPlatformFamilyId[];
  provider: 'python-build-standalone';
  series: {
    from: string;
    major: 3;
    through: 'latest-stable';
  };
  type: 'cpython-distributions';
}

export interface WorkspacePythonApplicationTarget extends WorkspaceTargetState {
  application: {
    extras: string[];
    features: Record<string, string>;
    recipe?: string;
    version?: string;
    versionSelection?: PythonApplicationVersionSelection;
  };
  coverage?: InlinePlatformCoveragePolicy | string;
  python?: PythonRuntimePolicy;
  spec: string;
  type: 'python-app';
}

export type WorkspaceTarget =
  | WorkspaceCpythonDistributionsTarget
  | WorkspaceGitTarget
  | WorkspaceNpmTarget
  | WorkspacePythonApplicationTarget;

export type WorkspaceTargetEditableField =
  | 'branch'
  | 'coverage'
  | 'fromMinor'
  | 'latest'
  | 'platforms'
  | 'python'
  | 'versionSelection'
  | 'windowDays';

export interface WorkspaceTargetEdit {
  branch?: string | null;
  coverage?: InlinePlatformCoveragePolicy | string | null;
  fromMinor?: string;
  latest?: number;
  platforms?: BuiltInPlatformFamilyId[];
  python?: PythonRuntimePolicy | null;
  versionSelection?: PythonApplicationVersionSelection;
  windowDays?: number;
}

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
    provisionGit: WorkspacePromptBoolean;
    publicRepositories: WorkspacePromptBoolean;
  };
  verifyInstall: {
    ignoreScripts: WorkspacePromptBoolean;
  };
}

export interface WorkspacePythonConfig {
  applicationDefaults?: {
    coverage: InlinePlatformCoveragePolicy | string;
    runtime: PythonRuntimePolicy;
  };
  applicationArtifactOwner?: string;
  planner: {
    engine: 'uv';
    version: typeof workspacePythonPlannerVersion;
  };
  publication?: PythonPublicationProfile;
  publishOwner?: string;
  sourceIndex: string;
}

export interface ResolvedWorkspacePythonApplication {
  coveragePolicy: PlatformCoveragePolicy;
  intent: PythonApplicationIntent;
  target: WorkspacePythonApplicationTarget;
  versionSelection: PythonApplicationVersionSelection;
}

export interface WorkspaceConfig {
  coveragePolicies?: PlatformCoveragePolicy[];
  defaults: WorkspaceDefaults;
  giteaUrl?: string;
  gitOwnerStrategy: GitOwnerStrategy;
  gitPublishOwner?: string;
  gitPublishOwnerKind?: GitPublishOwnerKind;
  npmSecurity?: NpmSecurityPolicy;
  npmRegistry?: NpmRegistryTarget;
  output: string;
  pythonPublishOwner?: string;
  pythonResolutionMode?: 'approximate' | 'locked-only';
  pythonSourceIndex?: string;
  pythonTargetEnvironments?: PythonTargetEnvironmentConfig[];
  python?: WorkspacePythonConfig;
  schemaVersion: 1 | 2;
  sourceRegistry: string;
  /** Legacy schema-v1/v2 field migrated to npmRegistry.type=verdaccio on read. */
  targetRegistry?: string;
  targets: WorkspaceTarget[];
}

export interface WorkspaceSecrets {
  giteaToken?: string;
  schemaVersion: 1;
}

interface WorkspaceGitTargetSnapshot extends WorkspaceTargetState {
  branch?: string;
  localMirrorPath: string;
  sourceId: string;
  type: 'git';
  url: string;
}

interface WorkspaceNpmTargetSnapshot extends WorkspaceTargetState {
  spec: string;
  type: 'npm';
}

interface WorkspaceCpythonDistributionsTargetSnapshot extends WorkspaceCpythonDistributionsTarget {}

interface WorkspacePythonApplicationTargetSnapshot extends WorkspacePythonApplicationTarget {}

export type WorkspaceTargetSnapshot =
  | WorkspaceCpythonDistributionsTargetSnapshot
  | WorkspaceGitTargetSnapshot
  | WorkspaceNpmTargetSnapshot
  | WorkspacePythonApplicationTargetSnapshot;

export interface WorkspaceSnapshot {
  createdAt: string;
  gitOwnerStrategy?: GitOwnerStrategy;
  gitPublishOwner?: string;
  gitPublishOwnerKind?: GitPublishOwnerKind;
  output: string;
  python?: WorkspacePythonConfig;
  coveragePolicies?: PlatformCoveragePolicy[];
  schemaVersion: 1 | 2;
  sourceRegistry: string;
  targets: WorkspaceTargetSnapshot[];
}

export interface InitWorkspaceOptions {
  force?: boolean;
  workspaceDir: string;
}

export interface WorkspaceConfigMigrationResult {
  appliedMigrationIds: string[];
  backupPath?: string;
  config: WorkspaceConfig;
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
    coveragePolicies: [
      {
        id: 'desktop-x64',
        platforms: ['linux-glibc-x86_64'],
        version: 1,
        wheelStrategy: 'minimum-cover',
      },
    ],
    defaults: {
      download: {
        includeDev: true,
        includePeer: true,
        latestPolicy: 'bundled',
        prune: true,
        rangeResolutionPolicy: 'reuse-stable',
        tagResolutionPolicy: 'reuse-stable',
      },
      publish: {
        configureGitGlobal: false,
        provisionGit: true,
        publicRepositories: true,
      },
      verifyInstall: {
        ignoreScripts: true,
      },
    },
    gitOwnerStrategy: 'preserve',
    output: defaultWorkspaceOutputDir,
    python: {
      applicationDefaults: {
        coverage: 'desktop-x64',
        runtime: {
          policy: 'selected',
          versions: [...initialPythonApplicationMinors],
        },
      },
      planner: {
        engine: 'uv',
        version: workspacePythonPlannerVersion,
      },
      publication: defaultPythonPublicationProfile(),
      sourceIndex: defaultWorkspacePythonSourceIndex,
    },
    schemaVersion: 2,
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

export function workspaceConfigV1BackupPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), workspaceConfigV1BackupFileName);
}

export function workspaceSecretsPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), workspaceSecretsFileName);
}

function normalizePythonRuntimePolicy(value: unknown): PythonRuntimePolicy {
  if (value === undefined) {
    return { policy: 'selected', versions: [...initialPythonApplicationMinors] };
  }
  if (
    !isRecord(value) ||
    (value.policy !== 'auto' && value.policy !== 'constrained' && value.policy !== 'selected')
  ) {
    throw new Error('python-app target python policy must be auto, constrained, or selected');
  }
  if (value.policy === 'auto') {
    return { policy: 'selected', versions: [...initialPythonApplicationMinors] };
  }
  if (value.policy === 'selected') {
    if (
      !Array.isArray(value.versions) ||
      value.versions.length === 0 ||
      !value.versions.every(
        (version): version is string =>
          typeof version === 'string' && /^3\.\d+$/u.test(version.trim())
      )
    ) {
      throw new Error(
        'selected python-app target requires one or more Python minor versions, e.g. 3.12'
      );
    }
    return {
      policy: 'selected',
      versions: [...new Set(value.versions.map((version) => version.trim()))],
    };
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

function normalizePythonApplicationCoverage(value: unknown): InlinePlatformCoveragePolicy | string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return normalizeInlinePlatformCoveragePolicy(value);
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

function normalizePythonApplicationVersionSelection(
  value: unknown
): PythonApplicationVersionSelection | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.selectors) || value.selectors.length === 0) {
    throw new Error('python-app application.versionSelection must contain one or more selectors');
  }
  const selectors: PythonApplicationVersionSelector[] = [];
  const seen = new Set<string>();
  for (const item of value.selectors) {
    if (!isRecord(item) || (item.type !== 'exact' && item.type !== 'latest-compatible')) {
      throw new Error('python-app version selector type must be exact or latest-compatible');
    }
    let selector: PythonApplicationVersionSelector;
    if (item.type === 'exact') {
      if (typeof item.version !== 'string') {
        throw new Error('exact python-app version selector requires a PEP 440 version');
      }
      const version = normalizeVersion(item.version.trim());
      if (!version) {
        throw new Error(`Invalid exact python-app version: ${item.version}`);
      }
      selector = { type: 'exact', version };
    } else {
      const constraint =
        typeof item.constraint === 'string' && item.constraint.trim()
          ? item.constraint.trim()
          : undefined;
      if (constraint && !isValidSpecifierSet(constraint)) {
        throw new Error(`Invalid latest-compatible python-app constraint: ${constraint}`);
      }
      selector = {
        ...(constraint ? { constraint } : {}),
        type: 'latest-compatible',
      };
    }
    const key = semanticDigest(selector);
    if (!seen.has(key)) {
      selectors.push(selector);
      seen.add(key);
    }
  }
  return { selectors };
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
  const versionSelection = normalizePythonApplicationVersionSelection(application.versionSelection);
  if (explicitVersion && parsed.requirement.specifier) {
    throw new Error(
      'python-app target version must be set either in spec or application.version, not both'
    );
  }
  const version = explicitVersion ?? (parsed.requirement.specifier || undefined);
  if (version && !isValidSpecifierSet(version)) {
    throw new Error('python-app application.version must be a valid version specifier');
  }
  if (versionSelection && version) {
    throw new Error(
      'python-app target must use either application.version or application.versionSelection'
    );
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

  const coverage =
    value.coverage === undefined ? undefined : normalizePythonApplicationCoverage(value.coverage);

  return {
    application: {
      extras,
      features: normalizeStringMap(application.features, 'python-app application.features'),
      ...(typeof application.recipe === 'string' && application.recipe.trim()
        ? { recipe: application.recipe.trim() }
        : {}),
      ...(version ? { version } : {}),
      ...(versionSelection ? { versionSelection } : {}),
    },
    ...(coverage ? { coverage } : {}),
    ...normalizeWorkspaceTargetState(value),
    ...(value.python !== undefined ? { python: normalizePythonRuntimePolicy(value.python) } : {}),
    spec: parsed.requirement.normalizedName,
    type: 'python-app',
  };
}

function normalizeWorkspaceTargetState(value: Record<string, unknown>): WorkspaceTargetState {
  if (value.paused !== undefined && typeof value.paused !== 'boolean') {
    throw new Error('Workspace target paused must be a boolean');
  }
  return value.paused === true ? { paused: true } : {};
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
      ...normalizeWorkspaceTargetState(value),
      type: 'git',
      url: value.url.trim(),
    };
  }

  if (value.type === 'npm') {
    if (typeof value.spec !== 'string' || value.spec.trim().length === 0) {
      throw new Error('npm target must include a non-empty spec');
    }
    return {
      ...normalizeWorkspaceTargetState(value),
      spec: value.spec.trim(),
      type: 'npm',
    };
  }

  if (value.type === 'python-app') {
    return normalizePythonApplicationTarget(value);
  }

  if (value.type === 'cpython-distributions') {
    const platforms = Array.isArray(value.platforms) ? [...new Set(value.platforms)] : [];
    if (
      platforms.length === 0 ||
      !platforms.every(
        (platform): platform is BuiltInPlatformFamilyId =>
          typeof platform === 'string' && isBuiltInPlatformFamilyId(platform)
      )
    ) {
      throw new Error('cpython-distributions platforms must contain supported platform family ids');
    }
    if (value.provider !== 'python-build-standalone') {
      throw new Error('cpython-distributions provider must be python-build-standalone');
    }
    if (
      !isRecord(value.series) ||
      value.series.major !== 3 ||
      typeof value.series.from !== 'string' ||
      !/^3\.\d+$/u.test(value.series.from.trim()) ||
      value.series.through !== 'latest-stable'
    ) {
      throw new Error(
        'cpython-distributions series must use major 3, a 3.X lower bound, and latest-stable'
      );
    }
    if (
      !isRecord(value.patches) ||
      !Number.isSafeInteger(value.patches.latest) ||
      (value.patches.latest as number) <= 0
    ) {
      throw new Error('cpython-distributions patches.latest must be a positive integer');
    }
    if (
      !isRecord(value.builds) ||
      !Number.isSafeInteger(value.builds.windowDays) ||
      (value.builds.windowDays as number) <= 0
    ) {
      throw new Error('cpython-distributions builds.windowDays must be a positive integer');
    }
    return {
      builds: { windowDays: value.builds.windowDays as number },
      patches: { latest: value.patches.latest as number },
      platforms: platforms.sort(),
      ...normalizeWorkspaceTargetState(value),
      provider: 'python-build-standalone',
      series: {
        from: value.series.from.trim(),
        major: 3,
        through: 'latest-stable',
      },
      type: 'cpython-distributions',
    };
  }

  if (value.type === 'pypi' || value.type === 'python-wheel') {
    throw new Error(
      `${value.type} targets were removed with legacy Python seeding; use a python-app target`
    );
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
      provisionGit: normalizePromptBoolean(publish.provisionGit, defaults.publish.provisionGit),
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

function normalizeNpmSecurityPolicy(value: unknown): NpmSecurityPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('npmSecurity must be an object');
  }
  const allowPackages = value.allowPackages;
  if (
    allowPackages !== undefined &&
    (!Array.isArray(allowPackages) ||
      !allowPackages.every((item): item is string => typeof item === 'string'))
  ) {
    throw new Error('npmSecurity.allowPackages must be an array of strings');
  }
  const maxReportAgeHours = value.maxReportAgeHours ?? 72;
  const minReleaseAgeDays = value.minReleaseAgeDays ?? 3;
  const vulnerabilityResolutionPolicy = value.vulnerabilityResolutionPolicy ?? 'prefer-clean';
  if (
    typeof maxReportAgeHours !== 'number' ||
    !Number.isInteger(maxReportAgeHours) ||
    maxReportAgeHours < 1
  ) {
    throw new Error('npmSecurity.maxReportAgeHours must be a positive integer');
  }
  if (
    typeof minReleaseAgeDays !== 'number' ||
    !Number.isInteger(minReleaseAgeDays) ||
    minReleaseAgeDays < 0
  ) {
    throw new Error('npmSecurity.minReleaseAgeDays must be a non-negative integer');
  }
  if (
    vulnerabilityResolutionPolicy !== 'prefer-clean' &&
    vulnerabilityResolutionPolicy !== 'report-only'
  ) {
    throw new Error(
      'npmSecurity.vulnerabilityResolutionPolicy must be "prefer-clean" or "report-only"'
    );
  }
  return {
    allowPackages: [...(allowPackages ?? [])],
    maxReportAgeHours,
    minReleaseAgeDays,
    vulnerabilityResolutionPolicy,
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

function normalizeWorkspacePythonConfig(
  value: unknown,
  defaultCoverage: InlinePlatformCoveragePolicy | string
): WorkspacePythonConfig {
  if (!isRecord(value)) {
    throw new Error('python settings must be an object');
  }
  const applicationDefaults =
    value.applicationDefaults === undefined
      ? {}
      : isRecord(value.applicationDefaults)
        ? value.applicationDefaults
        : undefined;
  if (!applicationDefaults) {
    throw new Error('python.applicationDefaults must be an object');
  }
  const sourceIndex = normalizeHttpUrl(
    optionalString(value.sourceIndex) ?? defaultWorkspacePythonSourceIndex,
    'python.sourceIndex'
  );
  const publishOwner = optionalString(value.publishOwner);
  const applicationArtifactOwner = optionalString(value.applicationArtifactOwner);
  const publication =
    value.publication !== undefined
      ? normalizePythonPublicationProfile(value.publication)
      : undefined;
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

  if (value.legacySeed !== undefined) {
    throw new Error(
      'python.legacySeed was removed; delete it and use python-app targets for Python applications'
    );
  }

  return {
    applicationDefaults: {
      coverage: normalizePythonApplicationCoverage(applicationDefaults.coverage ?? defaultCoverage),
      runtime: normalizePythonRuntimePolicy(applicationDefaults.runtime),
    },
    ...(applicationArtifactOwner ? { applicationArtifactOwner } : {}),
    planner: {
      engine: 'uv',
      version: workspacePythonPlannerVersion,
    },
    ...(publication ? { publication } : {}),
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
  if (
    schemaVersion === 1 &&
    targets.some(
      (target) => target.type === 'python-app' || target.type === 'cpython-distributions'
    )
  ) {
    throw new Error(
      'python-app and cpython-distributions targets require workspace schemaVersion 2'
    );
  }
  const defaultApplicationCoverage: InlinePlatformCoveragePolicy | string = coveragePolicies[0]
    ?.id ?? {
    platforms: ['linux-glibc-x86_64'],
    version: 1,
    wheelStrategy: 'minimum-cover',
  };
  const python =
    schemaVersion === 2 &&
    (value.python !== undefined || targets.some((target) => target.type === 'python-app'))
      ? normalizeWorkspacePythonConfig(value.python ?? {}, defaultApplicationCoverage)
      : undefined;
  const coveragePolicyIds = new Set(coveragePolicies.map((policy) => policy.id));
  if (
    python &&
    typeof python.applicationDefaults?.coverage === 'string' &&
    !coveragePolicyIds.has(python.applicationDefaults.coverage)
  ) {
    throw new Error(
      `python.applicationDefaults references unknown coverage policy: ${python.applicationDefaults.coverage}`
    );
  }
  const pythonApplicationSelections = new Set<string>();
  for (const target of targets) {
    if (
      target.type === 'python-app' &&
      typeof target.coverage === 'string' &&
      !coveragePolicyIds.has(target.coverage)
    ) {
      throw new Error(`python-app target references unknown coverage policy: ${target.coverage}`);
    }
    if (target.type === 'python-app') {
      const effectiveCoverage = target.coverage ?? python?.applicationDefaults?.coverage;
      if (!effectiveCoverage) {
        throw new Error(`python-app target ${target.spec} has no application coverage`);
      }
      const selection = `${target.spec}\0${semanticDigest(effectiveCoverage)}`;
      if (pythonApplicationSelections.has(selection)) {
        throw new Error(
          `Duplicate python-app target for ${target.spec} and the same coverage; combine its version selectors`
        );
      }
      pythonApplicationSelections.add(selection);
    }
  }

  const giteaUrl = optionalString(value.giteaUrl);
  if (value.npmRegistry !== undefined && value.targetRegistry !== undefined) {
    throw new Error('Configure npmRegistry or legacy targetRegistry, not both');
  }
  const npmRegistry =
    value.npmRegistry === undefined ? undefined : normalizeNpmRegistryTarget(value.npmRegistry);
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
  const pythonResolutionMode: 'approximate' | 'locked-only' | undefined =
    schemaVersion === 1
      ? value.pythonResolutionMode === 'approximate'
        ? 'approximate'
        : 'locked-only'
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
  const npmSecurity = normalizeNpmSecurityPolicy(value.npmSecurity);
  if (gitOwnerStrategy === 'fixed-owner' && (!gitPublishOwner || !gitPublishOwnerKind)) {
    throw new Error(
      'fixed-owner gitOwnerStrategy requires gitPublishOwner and gitPublishOwnerKind'
    );
  }
  return {
    defaults: normalizeWorkspaceDefaults(value.defaults),
    ...(giteaUrl ? { giteaUrl } : {}),
    gitOwnerStrategy,
    ...(gitPublishOwner ? { gitPublishOwner } : {}),
    ...(gitPublishOwnerKind ? { gitPublishOwnerKind } : {}),
    ...(npmSecurity ? { npmSecurity } : {}),
    ...(npmRegistry ? { npmRegistry } : {}),
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

  const config = createDefaultWorkspaceConfig();
  await fs.writeJson(configPath, config, { spaces: 2 });
  await fs.ensureDir(path.resolve(workspaceDir, config.output));
  if (config.schemaVersion === 2) {
    await installMaintainedPythonApplicationRecipes(workspaceDir);
  }
  return config;
}

async function readWorkspaceConfigWithoutMigration(workspaceDir: string): Promise<WorkspaceConfig> {
  return normalizeWorkspaceConfig(await fs.readJson(workspaceConfigPath(workspaceDir)));
}

export async function readWorkspaceConfig(workspaceDir: string): Promise<WorkspaceConfig> {
  return (await migrateWorkspaceConfig(workspaceDir)).config;
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
  const coverage =
    target.coverage ??
    config.python?.applicationDefaults?.coverage ??
    config.coveragePolicies?.[0]?.id;
  if (!coverage) {
    throw new Error(`Python application ${target.spec} has no configured coverage`);
  }
  const coveragePolicy =
    typeof coverage === 'string'
      ? config.coveragePolicies?.find((policy) => policy.id === coverage)
      : {
          id: `inline-${platformCoveragePolicyDigest(coverage).slice(0, 12)}`,
          ...coverage,
        };
  if (!coveragePolicy) {
    throw new Error(`Unknown coverage policy: ${coverage as string}`);
  }
  const python = target.python ??
    config.python?.applicationDefaults?.runtime ?? {
      policy: 'selected' as const,
      versions: [...initialPythonApplicationMinors],
    };
  const versionSelection = target.application.versionSelection ?? {
    selectors: [
      {
        ...(target.application.version ? { constraint: target.application.version } : {}),
        type: 'latest-compatible' as const,
      },
    ],
  };
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
      coverage: typeof coverage === 'string' ? { policyId: coverage } : { inline: coverage },
      python,
      source: {
        ...(config.python?.sourceIndex ? { indexUrl: config.python.sourceIndex } : {}),
        type: 'pypi',
      },
      updatePolicy: 'manual',
    },
    target,
    versionSelection,
  };
}

export function pythonApplicationIntentForVersionSelector(
  application: ResolvedWorkspacePythonApplication,
  selector: PythonApplicationVersionSelector
): PythonApplicationIntent {
  const version = selector.type === 'exact' ? `==${selector.version}` : selector.constraint;
  return {
    ...application.intent,
    application: {
      ...application.intent.application,
      ...(version ? { version } : {}),
    },
  };
}

export function previewWorkspaceConfigMigration(config: WorkspaceConfig): WorkspaceConfig {
  const normalized = normalizeWorkspaceConfig(config);
  if (normalized.schemaVersion === 2) {
    return normalized;
  }

  const pythonPublishOwner = normalized.pythonPublishOwner;
  const pythonSourceIndex = normalized.pythonSourceIndex;
  const common = { ...normalized };
  delete common.pythonPublishOwner;
  delete common.pythonResolutionMode;
  delete common.pythonSourceIndex;
  delete common.pythonTargetEnvironments;
  const hasLegacyPythonIntent = pythonPublishOwner !== undefined || pythonSourceIndex !== undefined;
  const migrated: WorkspaceConfig = {
    ...common,
    coveragePolicies: [],
    ...(hasLegacyPythonIntent
      ? {
          python: {
            applicationDefaults: {
              coverage: {
                platforms: ['linux-glibc-x86_64'],
                version: 1,
                wheelStrategy: 'minimum-cover',
              },
              runtime: {
                policy: 'selected',
                versions: [...initialPythonApplicationMinors],
              },
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

interface WorkspaceConfigMigration {
  apply: (config: WorkspaceConfig) => WorkspaceConfig;
  backupFileName: string;
  id: string;
  isApplied: (config: WorkspaceConfig) => boolean;
}

function addWorkspacePythonPublicationDefaults(config: WorkspaceConfig): WorkspaceConfig {
  const normalized = normalizeWorkspaceConfig(config);
  if (normalized.schemaVersion !== 2) {
    return normalized;
  }
  return normalizeWorkspaceConfig({
    ...normalized,
    python: {
      applicationArtifactOwner: defaultWorkspacePythonApplicationArtifactOwner,
      planner: {
        engine: 'uv',
        version: workspacePythonPlannerVersion,
      },
      publishOwner: defaultWorkspacePythonPublishOwner,
      sourceIndex: defaultWorkspacePythonSourceIndex,
      ...normalized.python,
    },
  });
}

function addWorkspacePythonPublicationProfile(config: WorkspaceConfig): WorkspaceConfig {
  const normalized = normalizeWorkspaceConfig(config);
  if (normalized.schemaVersion !== 2 || normalized.python?.publication) {
    return normalized;
  }
  const publishOwner = normalized.python?.publishOwner;
  const applicationArtifactOwner = normalized.python?.applicationArtifactOwner;
  if (
    publishOwner !== defaultWorkspacePythonPublishOwner ||
    applicationArtifactOwner !== defaultWorkspacePythonApplicationArtifactOwner
  ) {
    throw new Error(
      'Custom legacy Python publication owners cannot be migrated safely. Configure ' +
        'python.publication.owner with an explicit strategy and owner kind.'
    );
  }
  return normalizeWorkspaceConfig({
    ...normalized,
    python: {
      applicationDefaults: normalized.python!.applicationDefaults!,
      planner: normalized.python!.planner,
      publication: defaultPythonPublicationProfile(),
      sourceIndex: normalized.python!.sourceIndex,
    },
  });
}

function addWorkspaceNpmRegistryTarget(config: WorkspaceConfig): WorkspaceConfig {
  const normalized = normalizeWorkspaceConfig(config);
  if (normalized.npmRegistry || !normalized.targetRegistry) {
    return normalized;
  }
  const migrated = { ...normalized };
  delete migrated.targetRegistry;
  return normalizeWorkspaceConfig({
    ...migrated,
    npmRegistry: {
      type: 'verdaccio',
      url: normalized.targetRegistry,
    },
  });
}

const workspaceConfigMigrations: WorkspaceConfigMigration[] = [
  {
    apply: previewWorkspaceConfigMigration,
    backupFileName: workspaceConfigV1BackupFileName,
    id: '0001-workspace-schema-v2',
    isApplied: (config) => config.schemaVersion === 2,
  },
  {
    apply: addWorkspacePythonPublicationDefaults,
    backupFileName: workspaceConfigPythonPublicationBackupFileName,
    id: '0002-python-application-publication',
    isApplied: (config) =>
      config.schemaVersion !== 2 ||
      Boolean(config.python?.publication) ||
      Boolean(config.python?.applicationArtifactOwner && config.python.publishOwner),
  },
  {
    apply: addWorkspacePythonPublicationProfile,
    backupFileName: workspaceConfigPythonPublicationProfileBackupFileName,
    id: '0003-python-publication-profile',
    isApplied: (config) => config.schemaVersion !== 2 || Boolean(config.python?.publication),
  },
  {
    apply: addWorkspaceNpmRegistryTarget,
    backupFileName: workspaceConfigNpmRegistryTargetBackupFileName,
    id: '0004-npm-registry-target',
    isApplied: (config) => config.targetRegistry === undefined,
  },
];

export async function previewWorkspaceMigration(workspaceDir: string): Promise<WorkspaceConfig> {
  let config = await readWorkspaceConfigWithoutMigration(workspaceDir);
  for (const migration of workspaceConfigMigrations) {
    if (!migration.isApplied(config)) {
      config = migration.apply(config);
    }
  }
  return config;
}

export async function migrateWorkspaceConfig(
  workspaceDir: string
): Promise<WorkspaceConfigMigrationResult> {
  const configPath = workspaceConfigPath(workspaceDir);
  let config = await readWorkspaceConfigWithoutMigration(workspaceDir);
  const appliedMigrationIds: string[] = [];
  let backupFileName: string | undefined;

  for (const migration of workspaceConfigMigrations) {
    if (migration.isApplied(config)) {
      continue;
    }
    backupFileName ??= migration.backupFileName;
    config = migration.apply(config);
    appliedMigrationIds.push(migration.id);
  }

  if (appliedMigrationIds.length === 0) {
    return { appliedMigrationIds, config };
  }

  const backupPath = path.join(path.resolve(workspaceDir), backupFileName!);
  if (!(await fs.pathExists(backupPath))) {
    await fs.writeFileAtomic(backupPath, await fs.readFile(configPath, 'utf8'));
  }
  await installMaintainedPythonApplicationRecipes(workspaceDir);
  await fs.writeJsonAtomic(configPath, config, { spaces: 2 });
  return {
    appliedMigrationIds,
    backupPath,
    config,
  };
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
  await fs.writeJsonAtomic(workspaceConfigPath(workspaceDir), normalizeWorkspaceConfig(config), {
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
  return target.type === 'cpython-distributions'
    ? [
        target.type,
        semanticDigest({
          builds: target.builds,
          patches: target.patches,
          platforms: target.platforms,
          provider: target.provider,
          series: target.series,
        }),
      ].join('\0')
    : target.type === 'git'
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
        : [target.type, target.spec].join('\0');
}

const workspaceTargetEditFields: WorkspaceTargetEditableField[] = [
  'branch',
  'coverage',
  'fromMinor',
  'latest',
  'platforms',
  'python',
  'versionSelection',
  'windowDays',
];

export function workspaceTargetEditableFields(
  target: WorkspaceTarget
): WorkspaceTargetEditableField[] {
  switch (target.type) {
    case 'cpython-distributions':
      return ['fromMinor', 'platforms', 'latest', 'windowDays'];
    case 'git':
      return ['branch'];
    case 'npm':
      return [];
    case 'python-app':
      return ['coverage', 'python', 'versionSelection'];
  }
}

function requestedWorkspaceTargetEditFields(
  edit: WorkspaceTargetEdit
): WorkspaceTargetEditableField[] {
  return workspaceTargetEditFields.filter((field) => edit[field] !== undefined);
}

export async function addWorkspaceTarget(
  workspaceDir: string,
  target: WorkspaceTarget
): Promise<{ added: boolean; config: WorkspaceConfig }> {
  const config = await readWorkspaceConfig(workspaceDir);
  const normalizedTarget = normalizeWorkspaceTarget(target);
  const id = targetKey(normalizedTarget);
  const exists = config.targets.some((existing) => targetKey(existing) === id);
  const effectiveCoverage =
    normalizedTarget.type === 'python-app'
      ? (normalizedTarget.coverage ?? config.python?.applicationDefaults?.coverage)
      : undefined;
  if (
    !exists &&
    normalizedTarget.type === 'python-app' &&
    config.targets.some(
      (existing) =>
        existing.type === 'python-app' &&
        existing.spec === normalizedTarget.spec &&
        semanticDigest(existing.coverage ?? config.python?.applicationDefaults?.coverage) ===
          semanticDigest(effectiveCoverage)
    )
  ) {
    throw new Error(
      `Python application ${normalizedTarget.spec} already has a target for this coverage; update its version selection instead`
    );
  }
  if (!exists) {
    config.targets.push(normalizedTarget);
    await writeWorkspaceConfig(workspaceDir, config);
  }

  return { added: !exists, config };
}

export async function editWorkspaceTarget(
  workspaceDir: string,
  index: number,
  edit: WorkspaceTargetEdit
): Promise<{ changed: boolean; config: WorkspaceConfig; target: WorkspaceTarget }> {
  const config = await readWorkspaceConfig(workspaceDir);
  if (!Number.isInteger(index) || index < 1 || index > config.targets.length) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }
  const current = config.targets[index - 1];
  if (!current) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }

  const editableFields = workspaceTargetEditableFields(current);
  const requestedFields = requestedWorkspaceTargetEditFields(edit);
  if (requestedFields.length === 0) {
    throw new Error(
      editableFields.length === 0
        ? `${current.type} target has no editable settings`
        : `No editable fields were provided for ${current.type} target`
    );
  }
  const unsupportedField = requestedFields.find((field) => !editableFields.includes(field));
  if (unsupportedField) {
    if (unsupportedField === 'versionSelection') {
      throw new Error(`Target ${String(index)} is not a python-app target`);
    }
    throw new Error(`${unsupportedField} cannot be edited for ${current.type} targets`);
  }

  let candidate: WorkspaceTarget;
  switch (current.type) {
    case 'cpython-distributions':
      candidate = {
        ...current,
        builds: { windowDays: edit.windowDays ?? current.builds.windowDays },
        patches: { latest: edit.latest ?? current.patches.latest },
        platforms: edit.platforms ?? current.platforms,
        series: {
          ...current.series,
          from: edit.fromMinor ?? current.series.from,
        },
      };
      break;
    case 'git': {
      candidate = { ...current };
      if (edit.branch !== undefined) {
        if (edit.branch === null) {
          delete candidate.branch;
        } else {
          candidate.branch = edit.branch;
        }
      }
      break;
    }
    case 'python-app': {
      const applicationTarget: WorkspacePythonApplicationTarget = {
        ...current,
        application: {
          ...current.application,
        },
      };
      if (edit.versionSelection !== undefined) {
        applicationTarget.application.versionSelection = edit.versionSelection;
        delete applicationTarget.application.version;
      }
      if (edit.coverage !== undefined) {
        if (edit.coverage === null) {
          delete applicationTarget.coverage;
        } else {
          applicationTarget.coverage = edit.coverage;
        }
      }
      if (edit.python !== undefined) {
        if (edit.python === null) {
          delete applicationTarget.python;
        } else {
          applicationTarget.python = edit.python;
        }
      }
      candidate = applicationTarget;
      break;
    }
    case 'npm':
      throw new Error('npm target has no editable settings');
  }

  const target = normalizeWorkspaceTarget(candidate);
  const duplicateIndex = config.targets.findIndex(
    (existing, existingIndex) =>
      existingIndex !== index - 1 && targetKey(existing) === targetKey(target)
  );
  if (duplicateIndex >= 0) {
    throw new Error(
      `Edited target ${String(index)} would duplicate target ${String(duplicateIndex + 1)}`
    );
  }

  const changed = semanticDigest(current) !== semanticDigest(target);
  if (changed) {
    config.targets[index - 1] = target;
    await writeWorkspaceConfig(workspaceDir, config);
  }
  return { changed, config, target };
}

export async function setWorkspacePythonApplicationVersionSelection(
  workspaceDir: string,
  index: number,
  versionSelection: PythonApplicationVersionSelection
): Promise<{
  config: WorkspaceConfig;
  target: WorkspacePythonApplicationTarget;
}> {
  const result = await editWorkspaceTarget(workspaceDir, index, { versionSelection });
  if (result.target.type !== 'python-app') {
    throw new Error(`Target ${String(index)} is not a python-app target`);
  }
  return { config: result.config, target: result.target };
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

export async function setWorkspaceTargetPaused(
  workspaceDir: string,
  index: number,
  paused: boolean
): Promise<{ changed: boolean; config: WorkspaceConfig; target: WorkspaceTarget }> {
  const config = await readWorkspaceConfig(workspaceDir);
  if (!Number.isInteger(index) || index < 1 || index > config.targets.length) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }
  const current = config.targets[index - 1];
  if (!current) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }

  const target: WorkspaceTarget = { ...current, ...(paused ? { paused: true } : {}) };
  if (!paused) {
    delete target.paused;
  }
  const changed = (current.paused === true) !== paused;
  if (changed) {
    config.targets[index - 1] = target;
    await writeWorkspaceConfig(workspaceDir, config);
  }
  return { changed, config, target };
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
    gitOwnerStrategy: options.config.gitOwnerStrategy,
    ...(options.config.gitPublishOwner ? { gitPublishOwner: options.config.gitPublishOwner } : {}),
    ...(options.config.gitPublishOwnerKind
      ? { gitPublishOwnerKind: options.config.gitPublishOwnerKind }
      : {}),
    output: options.config.output,
    ...(options.config.python ? { python: options.config.python } : {}),
    ...(options.config.coveragePolicies
      ? { coveragePolicies: options.config.coveragePolicies }
      : {}),
    schemaVersion: options.config.schemaVersion,
    sourceRegistry: options.config.sourceRegistry,
    targets: options.config.targets.map((target) => {
      if (target.type === 'cpython-distributions') {
        return {
          builds: target.builds,
          patches: target.patches,
          platforms: target.platforms,
          ...(target.paused ? { paused: true } : {}),
          provider: target.provider,
          series: target.series,
          type: target.type,
        };
      }

      if (target.type === 'npm') {
        return {
          ...(target.paused ? { paused: true } : {}),
          spec: target.spec,
          type: target.type,
        };
      }

      if (target.type === 'python-app') {
        return {
          application: target.application,
          ...(target.coverage ? { coverage: target.coverage } : {}),
          ...(target.paused ? { paused: true } : {}),
          ...(target.python ? { python: target.python } : {}),
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
        ...(target.paused ? { paused: true } : {}),
        sourceId: source.id,
        type: 'git',
        url: target.url,
      };
    }),
  };
}
