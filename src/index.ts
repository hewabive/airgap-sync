export const packageName = 'npm-registry-seed';

export {
  createBundleDocuments,
  createFetchReport,
  writeBundleDocuments,
  writeFetchReport,
} from './core/bundle.js';
export { packageFileName } from './core/files.js';
export { HttpRegistryClient } from './core/registry.js';
export { resolveRootRequirementFromMetadata, resolveRootRequirements } from './core/resolver.js';
export { parseRootSpecs } from './core/specs.js';
export { downloadResolvedPackage } from './core/tarball.js';

export type { BundleDocuments, BundleDocumentsOptions, FetchReportOptions } from './core/bundle.js';

export type { DownloadedTarball } from './core/tarball.js';

export type { RegistryClient, HttpRegistryClientOptions } from './core/registry.js';

export type {
  BundleManifest,
  DistTagsManifest,
  FetchReport,
  PackageMetadata,
  PackageVersionMetadata,
  ParseRootSpecsResult,
  PackageIdentity,
  ResolutionError,
  ResolveRootRequirementsResult,
  ResolvedRootPackage,
  RootPackageRequirement,
  ResolvedPackage,
  SupportedSpecType,
  TagRequirement,
  UnsupportedRootPackageRequirement,
} from './types.js';
