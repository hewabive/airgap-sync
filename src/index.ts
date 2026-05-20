export const packageName = 'npm-registry-seed';

export {
  createBundleDocuments,
  createFetchReport,
  readBundleManifest,
  readDistTagsManifest,
  writeBundleDocuments,
  writeFetchReport,
  writePublishReport,
} from './core/bundle.js';
export { fetchSeedBundle } from './core/fetcher.js';
export { packageFileName } from './core/files.js';
export { readBundleInfo } from './core/info.js';
export { readManifestRequirements } from './core/manifests.js';
export { HttpRegistryClient, isBlockedPublishRegistry } from './core/registry.js';
export { createPublishPlan, publishBundle } from './core/publisher.js';
export { resolveRootRequirementFromMetadata, resolveRootRequirements } from './core/resolver.js';
export { parseDependencySpec, parseRootSpecs } from './core/specs.js';
export {
  dependencySpecsFromManifest,
  downloadResolvedPackage,
  readPackageManifest,
} from './core/tarball.js';

export type { BundleDocuments, BundleDocumentsOptions, FetchReportOptions } from './core/bundle.js';
export type { FetchSeedBundleOptions, FetchSeedBundleResult } from './core/fetcher.js';
export type {
  BundleInfo,
  BundleInfoPackage,
  BundleInfoReportStatus,
  BundleInfoTag,
} from './core/info.js';
export type { ReadManifestRequirementsOptions } from './core/manifests.js';
export type { PublishBundleOptions } from './core/publisher.js';

export type { DownloadedTarball } from './core/tarball.js';

export type { RegistryClient, HttpRegistryClientOptions } from './core/registry.js';

export type {
  BundleManifest,
  DistTagsManifest,
  FetchReport,
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
  UnsupportedRootPackageRequirement,
} from './types.js';
