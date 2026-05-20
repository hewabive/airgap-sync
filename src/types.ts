export interface PackageIdentity {
  name: string;
  version: string;
}

export type SupportedSpecType = 'version' | 'range' | 'tag' | 'alias';

export interface RootPackageRequirement {
  name: string;
  raw: string;
  requiredBy: 'root';
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
  specifier: string;
  type: SupportedSpecType;
}

export interface ResolvedPackage extends PackageIdentity {
  file: string;
  resolvedFrom: ResolutionReason[];
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
