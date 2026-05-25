export interface PackageIdentity {
  name: string;
  version: string;
}

export type SupportedSpecType = 'version' | 'range' | 'tag' | 'alias';
export type LatestPolicy = 'bundled' | 'source';
export type TagResolutionPolicy = 'refresh' | 'reuse-stable';

export interface RootPackageRequirement {
  name: string;
  raw: string;
  requiredBy: string;
  specifier: string;
  type: SupportedSpecType;
  alias?: string;
  aliasTargetType?: Exclude<SupportedSpecType, 'alias'>;
}

export interface UnsupportedRootPackageRequirement {
  raw: string;
  reason: string;
  requiredBy: string;
  type: string;
}

export interface GitRequirement {
  committish?: string;
  fetchSpec?: string;
  gitRange?: string;
  gitSubdir?: string;
  hosted?: {
    domain?: string;
    project?: string;
    type?: string;
    user?: string;
  };
  name?: string;
  raw: string;
  rawSpec: string;
  requiredBy: string;
}

export interface SkippedGitRequirement {
  reason: string;
  requirement: GitRequirement;
}

export interface GitSource {
  committish?: string;
  fetchSpec?: string;
  gitRange?: string;
  gitSubdir?: string;
  host: string;
  id: string;
  localMirrorPath: string;
  owner: string;
  repo: string;
  requirements: GitRequirement[];
  sourceUrl: string;
  target?: boolean;
}

export interface GitSourcesManifest {
  schemaVersion: 1;
  createdAt: string;
  sources: GitSource[];
  skipped: SkippedGitRequirement[];
}

export interface CollectGitManifestScanError {
  error: string;
  mirrorPath: string;
  sourceId: string;
}

export interface CollectIterationReport {
  addedGitRequirements: number;
  addedRequirements: number;
  addedUnsupported: number;
  downloaded: number;
  errors: number;
  fetchMs: number;
  gitFetchMs: number;
  gitManifestScanMs: number;
  gitSources: number;
  iteration: number;
  resolved: number;
  scannedGitSources: number;
  skipped: number;
  totalMs: number;
}

export interface CollectTimings {
  bundleDocumentsMs: number;
  fetchIterationsMs: number;
  gitFetchMs: number;
  gitManifestScanMs: number;
  lockfileScanMs: number;
  manifestScanMs: number;
  repositoryUpdateMs: number;
  reportWriteMs: number;
  totalMs: number;
}

export interface CollectReport {
  dryRun: boolean;
  fetch: FetchReport;
  fixedPoint: boolean;
  generatedAt: string;
  gitFetch: GitFetchReport;
  gitManifestScanErrors: CollectGitManifestScanError[];
  gitSources: GitSourcesManifest;
  iterations: CollectIterationReport[];
  maxIterationsReached: boolean;
  outputDir: string;
  registryUrl: string;
  repositoryUpdate: RepositoryUpdateReport;
  root: string;
  timings: CollectTimings;
  wroteBundle: boolean;
}

export type GitFetchActionStatus = 'planned' | 'cloned' | 'updated' | 'error';

export interface GitFetchActionResult {
  changed?: boolean;
  error?: string;
  repository: string;
  sourceUrl: string;
  status: GitFetchActionStatus;
  targetPath: string;
}

export interface GitFetchReport {
  actions: GitFetchActionResult[];
  changed: number;
  cloned: number;
  dryRun: boolean;
  errors: GitFetchActionResult[];
  generatedAt: string;
  mirrorsDir: string;
  planned: number;
  totalRepositories: number;
  unchanged: number;
  updated: number;
}

export interface GitConfigRewriteRule {
  command: string;
  insteadOf: string;
  targetUrl: string;
}

export type GitApplyActionStatus = 'planned' | 'pushed' | 'missing-mirror' | 'error';

export interface GitApplyActionResult {
  error?: string;
  repository: string;
  sourcePath: string;
  status: GitApplyActionStatus;
  targetUrl: string;
}

export interface GitApplyReport {
  dryRun: boolean;
  errors: GitApplyActionResult[];
  generatedAt: string;
  gitConfigRewriteRules: GitConfigRewriteRule[];
  mirrorsDir: string;
  missingMirrors: number;
  planned: number;
  pushed: number;
  totalRepositories: number;
}

export type GitConfigActionStatus = 'planned' | 'configured' | 'error';

export interface GitConfigActionResult {
  error?: string;
  insteadOf: string;
  status: GitConfigActionStatus;
  targetUrl: string;
}

export interface GitConfigReport {
  configured: number;
  dryRun: boolean;
  errors: GitConfigActionResult[];
  generatedAt: string;
  planned: number;
  scope: 'global';
  totalRules: number;
}

export type GiteaRepositoryActionStatus = 'planned' | 'exists' | 'created' | 'error';
export type GiteaOrganizationActionStatus = 'planned' | 'exists' | 'created' | 'error';

export interface GiteaOrganizationActionResult {
  error?: string;
  owner: string;
  status: GiteaOrganizationActionStatus;
}

export interface GiteaRepositoryActionResult {
  error?: string;
  owner: string;
  private: boolean;
  repository: string;
  status: GiteaRepositoryActionStatus;
  targetUrl: string;
}

export interface GiteaRepositoryProvisionReport {
  created: number;
  dryRun: boolean;
  errors: GiteaRepositoryActionResult[];
  exists: number;
  generatedAt: string;
  giteaBaseUrl: string;
  organizationCreated: number;
  organizationErrors: GiteaOrganizationActionResult[];
  organizationExists: number;
  organizationPlanned: number;
  organizations: GiteaOrganizationActionResult[];
  planned: number;
  private: boolean;
  totalOrganizations: number;
  totalRepositories: number;
}

export type RepositoryUpdateStatus =
  | 'planned'
  | 'updated'
  | 'dirty'
  | 'detached'
  | 'not-git-repository'
  | 'error';

export interface RepositoryUpdateResult {
  error?: string;
  repository: string;
  status: RepositoryUpdateStatus;
}

export interface RepositoryUpdateReport {
  detached: number;
  dirty: number;
  dryRun: boolean;
  errors: RepositoryUpdateResult[];
  generatedAt: string;
  planned: number;
  repositories: RepositoryUpdateResult[];
  root: string;
  totalRepositories: number;
  updated: number;
}

export interface ParseRootSpecsResult {
  gitRequirements: GitRequirement[];
  requirements: RootPackageRequirement[];
  unsupported: UnsupportedRootPackageRequirement[];
}

export interface ResolutionReason {
  requiredBy: string;
  raw: string;
  specifier: string;
  type: SupportedSpecType;
}

export interface PackageVersionMetadata {
  dependencies?: Record<string, string>;
  dist: {
    integrity?: string;
    shasum?: string;
    tarball: string;
  };
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  version: string;
}

export interface PackageMetadata {
  'dist-tags'?: Record<string, string>;
  name: string;
  versions: Record<string, PackageVersionMetadata>;
}

export interface ResolvedRootPackage extends PackageIdentity {
  alias?: string;
  dependencies?: Record<string, string>;
  dist: PackageVersionMetadata['dist'];
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  raw: string;
  requiredBy: string;
  resolvedVia: Exclude<SupportedSpecType, 'alias'>;
  specifier: string;
  type: SupportedSpecType;
}

export interface ResolutionError {
  name: string;
  raw: string;
  reason: string;
  specifier: string;
  type: SupportedSpecType;
}

export interface ResolveRootRequirementsResult {
  resolved: ResolvedRootPackage[];
  errors: ResolutionError[];
  tagRequirements: TagRequirement[];
}

export interface ResolvedPackage extends PackageIdentity {
  file: string;
  tarball: string;
  resolvedFrom: ResolutionReason[];
}

export interface FetchTimings {
  dependencyScanMs: number;
  downloadMs: number;
  manifestReadMs: number;
  resolveMs: number;
  totalMs: number;
}

export interface FetchReport {
  downloaded: number;
  errors: ResolutionError[];
  generatedAt: string;
  gitRequirements: GitRequirement[];
  resolved: number;
  skipped: number;
  timings: FetchTimings;
  unsupported: UnsupportedRootPackageRequirement[];
}

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  version: string;
}

export interface ProjectPackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  private?: boolean;
  version?: string;
  workspaces?: string[] | { packages?: string[] };
}

export interface BundleManifest {
  schemaVersion: 1;
  createdAt: string;
  sourceRegistry: string;
  packages: ResolvedPackage[];
}

export interface TagRequirement extends PackageIdentity {
  requiredBy: string;
  tag: string;
}

export interface DistTagsManifest {
  schemaVersion: 1;
  createdAt: string;
  sourceRegistry: string;
  tags: Record<string, Record<string, string>>;
  requirements: TagRequirement[];
}

export type PublishActionStatus = 'planned' | 'published' | 'skipped' | 'tagged' | 'error';

export interface PublishActionResult {
  action: 'publish' | 'dist-tag';
  package: string;
  status: PublishActionStatus;
  error?: string;
  tag?: string;
}

export interface PublishTimings {
  cleanupMs: number;
  distTagsMs: number;
  dryRunMs: number;
  lookupMetadataMs: number;
  publishMs: number;
  totalMs: number;
  validateMs: number;
}

export interface PublishReport {
  dryRun: boolean;
  errors: PublishActionResult[];
  generatedAt: string;
  published: number;
  registry: string;
  restoredTags: number;
  skipped: number;
  timings: PublishTimings;
  totalPackages: number;
}

export interface ApplyBundleReport {
  dryRun: boolean;
  generatedAt: string;
  gitApply: GitApplyReport;
  gitConfig?: GitConfigReport;
  gitea: GiteaRepositoryProvisionReport;
  publish: PublishReport;
  registryUrl: string;
  succeeded: boolean;
}

export type BundlePruneObjectType = 'git-mirror' | 'npm-package';
export type BundlePruneActionStatus = 'planned' | 'removed' | 'error';

export interface BundlePruneActionResult {
  error?: string;
  path: string;
  status: BundlePruneActionStatus;
  type: BundlePruneObjectType;
}

export interface BundlePruneObjectSummary {
  kept: number;
  removed: number;
  stale: number;
  total: number;
}

export interface BundlePruneReport {
  actions: BundlePruneActionResult[];
  bundleDir: string;
  dryRun: boolean;
  errors: BundlePruneActionResult[];
  generatedAt: string;
  gitMirrors: BundlePruneObjectSummary;
  npmPackages: BundlePruneObjectSummary;
  planned: number;
  removed: number;
}

export type VerifyCheckStatus = 'ok' | 'warning' | 'error';

export interface VerifyCheck {
  details?: unknown;
  message: string;
  name: string;
  status: VerifyCheckStatus;
}

export interface VerifyReport {
  bundle: string;
  checks: VerifyCheck[];
  generatedAt: string;
  ok: boolean;
  summary: {
    errors: number;
    ok: number;
    warnings: number;
  };
}

export type VerifyInstallPackageManager = 'npm' | 'pnpm' | 'yarn';
export type VerifyInstallProjectStatus = 'passed' | 'failed' | 'skipped';

export interface VerifyInstallProjectResult {
  command?: string[];
  error?: string;
  exitCode?: number;
  packageManager?: VerifyInstallPackageManager;
  projectPath: string;
  reason?: string;
  status: VerifyInstallProjectStatus;
  stderr?: string;
  stdout?: string;
  targetUrl: string;
  tempPath?: string;
}

export interface VerifyInstallReport {
  bundle: string;
  failed: number;
  generatedAt: string;
  giteaBaseUrl: string;
  ignoreScripts: boolean;
  ok: boolean;
  passed: number;
  projects: VerifyInstallProjectResult[];
  registryUrl: string;
  skipped: number;
  totalProjects: number;
}
