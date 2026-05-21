export interface PackageIdentity {
  name: string;
  version: string;
}

export type SupportedSpecType = 'version' | 'range' | 'tag' | 'alias';

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

export interface GitMirrorRepositoryPlan {
  id: string;
  insteadOf: string[];
  repository: string;
  requirements: GitRequirement[];
  sourceUrl: string;
  targetUrl: string;
}

export interface SkippedGitRequirement {
  reason: string;
  requirement: GitRequirement;
}

export interface GitMirrorPlan {
  schemaVersion: 1;
  createdAt: string;
  giteaBaseUrl: string;
  owner: string;
  repositories: GitMirrorRepositoryPlan[];
  skipped: SkippedGitRequirement[];
}

export type GitFetchActionStatus = 'planned' | 'cloned' | 'updated' | 'error';

export interface GitFetchActionResult {
  error?: string;
  repository: string;
  sourceUrl: string;
  status: GitFetchActionStatus;
  targetPath: string;
}

export interface GitFetchReport {
  cloned: number;
  dryRun: boolean;
  errors: GitFetchActionResult[];
  generatedAt: string;
  mirrorsDir: string;
  planned: number;
  totalRepositories: number;
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

export type GiteaOwnerType = 'user' | 'org';
export type GiteaRepositoryActionStatus = 'planned' | 'exists' | 'created' | 'error';

export interface GiteaRepositoryActionResult {
  error?: string;
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
  owner: string;
  ownerType: GiteaOwnerType;
  planned: number;
  private: boolean;
  totalRepositories: number;
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
  version: string;
}

export interface PackageMetadata {
  'dist-tags'?: Record<string, string>;
  name: string;
  versions: Record<string, PackageVersionMetadata>;
}

export interface ResolvedRootPackage extends PackageIdentity {
  alias?: string;
  dist: PackageVersionMetadata['dist'];
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

export interface FetchReport {
  downloaded: number;
  errors: ResolutionError[];
  generatedAt: string;
  gitRequirements: GitRequirement[];
  resolved: number;
  skipped: number;
  unsupported: UnsupportedRootPackageRequirement[];
}

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  version: string;
}

export interface ProjectPackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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

export interface PublishReport {
  dryRun: boolean;
  errors: PublishActionResult[];
  generatedAt: string;
  published: number;
  registry: string;
  restoredTags: number;
  skipped: number;
  totalPackages: number;
}
