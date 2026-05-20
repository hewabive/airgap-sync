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
  type: string;
}

export interface ParseRootSpecsResult {
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
  resolved: number;
  skipped: number;
  unsupported: UnsupportedRootPackageRequirement[];
}

export interface PackageManifest {
  dependencies?: Record<string, string>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  version: string;
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
