export const packageName = 'npm-registry-seed';

export { HttpRegistryClient } from './core/registry.js';
export { resolveRootRequirementFromMetadata, resolveRootRequirements } from './core/resolver.js';
export { parseRootSpecs } from './core/specs.js';

export type { RegistryClient, HttpRegistryClientOptions } from './core/registry.js';

export type {
  BundleManifest,
  DistTagsManifest,
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
