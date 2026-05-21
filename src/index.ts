export const packageName = 'airgap-sync';

export {
  createBundleDocuments,
  createFetchReport,
  readBundleManifest,
  readDistTagsManifest,
  writeBundleDocuments,
  writeFetchReport,
  writePublishReport,
} from './core/bundle.js';
export { applyGitMirrors, createGitConfigRewriteRules } from './core/git-apply.js';
export { configureGitRewrites } from './core/git-config.js';
export { fetchSeedBundle } from './core/fetcher.js';
export { packageFileName } from './core/files.js';
export { fetchGitMirrors, runGitCommand } from './core/git-fetch.js';
export {
  createGitMirrorPlan,
  readFetchReport,
  readGitMirrorPlan,
  writeGitApplyReport,
  writeGitConfigReport,
  writeGitFetchReport,
  writeGitMirrorPlan,
} from './core/git-plan.js';
export { readBundleInfo } from './core/info.js';
export { readManifestRequirements } from './core/manifests.js';
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
  dependencySpecsFromManifest,
  downloadResolvedPackage,
  readPackageManifest,
} from './core/tarball.js';

export type { BundleDocuments, BundleDocumentsOptions, FetchReportOptions } from './core/bundle.js';
export type { FetchSeedBundleOptions, FetchSeedBundleResult } from './core/fetcher.js';
export type { ApplyGitMirrorsOptions } from './core/git-apply.js';
export type { ConfigureGitRewritesOptions } from './core/git-config.js';
export type {
  FetchGitMirrorsOptions,
  GitCommandInvocation,
  GitCommandRunner,
} from './core/git-fetch.js';
export type { GitMirrorPlanOptions } from './core/git-plan.js';
export type {
  BundleInfo,
  BundleInfoPackage,
  BundleInfoReportStatus,
  BundleInfoTag,
} from './core/info.js';
export type { ReadManifestRequirementsOptions } from './core/manifests.js';
export type { PublishBundleOptions } from './core/publisher.js';
export type {
  BundleValidationIssue,
  BundleValidationResult,
  BundleValidationSeverity,
} from './core/validation.js';

export type { DownloadedTarball } from './core/tarball.js';

export type { HttpRegistryClientOptions, RegistryClient } from './core/registry.js';

export type {
  BundleManifest,
  DistTagsManifest,
  FetchReport,
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
  GitMirrorPlan,
  GitMirrorRepositoryPlan,
  GitRequirement,
  PackageMetadata,
  PackageManifest,
  PackageVersionMetadata,
  ParseRootSpecsResult,
  PackageIdentity,
  ProjectPackageManifest,
  PublishActionResult,
  PublishActionStatus,
  PublishReport,
  ResolutionError,
  ResolveRootRequirementsResult,
  ResolvedRootPackage,
  RootPackageRequirement,
  ResolvedPackage,
  SupportedSpecType,
  TagRequirement,
  SkippedGitRequirement,
  UnsupportedRootPackageRequirement,
} from './types.js';
