export interface PackageIdentity {
  name: string;
  version: string;
}

export interface ResolutionReason {
  requiredBy: string;
  specifier: string;
  type: 'version' | 'range' | 'tag' | 'alias';
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
