export const packageName = 'airgap-sync';

export {
  createBundleDocuments,
  createFetchReport,
  readBundleManifest,
  readDistTagsManifest,
  readFetchReport,
  writeBundleDocuments,
  writeCollectReport,
  writeFetchReport,
  writeGiteaRepositoryProvisionReport,
  writeGitApplyReport,
  writeGitConfigReport,
  writeGitFetchReport,
  writePublishReport,
} from './core/bundle.js';
export { collectBundle } from './core/collect.js';
export { applyGitSources, createGitConfigRewriteRules } from './core/git-apply.js';
export { configureGitRewrites } from './core/git-config.js';
export { fetchSeedBundle } from './core/fetcher.js';
export { packageFileName } from './core/files.js';
export { readGitSourceManifestRequirements } from './core/git-manifests.js';
export { HttpGiteaClient, provisionGiteaRepositories } from './core/gitea.js';
export { fetchGitSources, runGitCommand } from './core/git-fetch.js';
export {
  createGitSourcesManifest,
  readGitSourcesManifest,
  writeGitSourcesManifest,
} from './core/git-sources.js';
export { readBundleInfo } from './core/info.js';
export { readManifestRequirements } from './core/manifests.js';
export { findGitRepositories, runGitOutputCommand, updateRepositories } from './core/repos.js';
export {
  CachedRegistryClient,
  HttpRegistryClient,
  isBlockedPublishRegistry,
} from './core/registry.js';
export { createPublishPlan, publishBundle } from './core/publisher.js';
export { resolveRootRequirementFromMetadata, resolveRootRequirements } from './core/resolver.js';
export { parseDependencySpec, parseRootSpecs } from './core/specs.js';
export { throwIfInvalidBundle, validateBundle } from './core/validation.js';
export {
  addWorkspaceTarget,
  defaultWorkspaceOutputDir,
  defaultWorkspaceReposDir,
  defaultWorkspaceSourceRegistry,
  gitTargetLocalPath,
  initWorkspace,
  materializeWorkspaceGitTargets,
  readWorkspaceConfig,
  removeWorkspaceTarget,
  workspaceConfigFileName,
  workspaceConfigPath,
  writeWorkspaceConfig,
} from './core/workspace.js';
export {
  dependencySpecsFromManifest,
  downloadResolvedPackage,
  readPackageManifest,
} from './core/tarball.js';
export {
  parseLockfileRequirementsFromContent,
  parseNpmLockRequirementsFromContent,
  parsePnpmLockRequirementsFromContent,
  parseYarnLockRequirementsFromContent,
  readLockfileRequirements,
} from './core/lockfiles.js';

export type { BundleDocuments, BundleDocumentsOptions, FetchReportOptions } from './core/bundle.js';
export type { CollectBundleOptions } from './core/collect.js';
export type { FetchSeedBundleOptions, FetchSeedBundleResult } from './core/fetcher.js';
export type { ApplyGitSourcesOptions } from './core/git-apply.js';
export type { ConfigureGitRewritesOptions } from './core/git-config.js';
export type {
  GiteaClient,
  HttpGiteaClientOptions,
  ProvisionGiteaRepositoriesOptions,
} from './core/gitea.js';
export type {
  FetchGitSourcesOptions,
  GitCommandInvocation,
  GitCommandRunner,
} from './core/git-fetch.js';
export type {
  GitSourceManifestRequirementsResult,
  ReadGitSourceManifestRequirementsOptions,
} from './core/git-manifests.js';
export type { GitSourcesOptions } from './core/git-sources.js';
export type {
  BundleInfo,
  BundleInfoPackage,
  BundleInfoReportStatus,
  BundleInfoTag,
} from './core/info.js';
export type { ReadManifestRequirementsOptions } from './core/manifests.js';
export type {
  PublishBundleOptions,
  PublishProgressEvent,
  PublishProgressPhase,
  PublishProgressStatus,
} from './core/publisher.js';
export type {
  GitOutputCommandInvocation,
  GitOutputCommandResult,
  GitOutputCommandRunner,
  UpdateRepositoriesOptions,
} from './core/repos.js';
export type {
  BundleValidationIssue,
  BundleValidationResult,
  BundleValidationSeverity,
} from './core/validation.js';
export type {
  InitWorkspaceOptions,
  MaterializeWorkspaceGitTargetsOptions,
  WorkspaceConfig,
  WorkspaceGitTarget,
  WorkspaceGitTargetResult,
  WorkspaceGitTargetsReport,
  WorkspaceGitTargetStatus,
  WorkspaceNpmTarget,
  WorkspaceTarget,
} from './core/workspace.js';

export type { DownloadedTarball } from './core/tarball.js';

export type { HttpRegistryClientOptions, RegistryClient } from './core/registry.js';

export type {
  BundleManifest,
  CollectTimings,
  CollectReport,
  DistTagsManifest,
  FetchReport,
  FetchTimings,
  GiteaOrganizationActionResult,
  GiteaOrganizationActionStatus,
  GiteaRepositoryActionResult,
  GiteaRepositoryActionStatus,
  GiteaRepositoryProvisionReport,
  GitApplyActionResult,
  GitApplyActionStatus,
  GitApplyReport,
  GitConfigActionResult,
  GitConfigActionStatus,
  GitConfigReport,
  GitConfigRewriteRule,
  GitFetchActionResult,
  GitFetchActionStatus,
  GitFetchReport,
  GitRequirement,
  GitSource,
  GitSourcesManifest,
  PackageMetadata,
  PackageManifest,
  PackageVersionMetadata,
  ParseRootSpecsResult,
  PackageIdentity,
  ProjectPackageManifest,
  PublishActionResult,
  PublishActionStatus,
  PublishTimings,
  PublishReport,
  RepositoryUpdateReport,
  RepositoryUpdateResult,
  RepositoryUpdateStatus,
  ResolutionError,
  ResolutionReason,
  ResolveRootRequirementsResult,
  ResolvedRootPackage,
  RootPackageRequirement,
  ResolvedPackage,
  SupportedSpecType,
  TagRequirement,
  SkippedGitRequirement,
  UnsupportedRootPackageRequirement,
} from './types.js';
