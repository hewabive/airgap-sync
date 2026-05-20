import semver from 'semver';
import type {
  PackageMetadata,
  ResolutionError,
  ResolveRootRequirementsResult,
  ResolvedRootPackage,
  RootPackageRequirement,
  TagRequirement,
} from '../types.js';
import type { RegistryClient } from './registry.js';

function specTypeForResolution(
  requirement: RootPackageRequirement
): Exclude<RootPackageRequirement['type'], 'alias'> {
  return requirement.type === 'alias' ? (requirement.aliasTargetType ?? 'tag') : requirement.type;
}

function chooseVersion(
  requirement: RootPackageRequirement,
  metadata: PackageMetadata
): {
  version?: string;
  reason?: string;
  resolvedVia: Exclude<RootPackageRequirement['type'], 'alias'>;
} {
  const resolvedVia = specTypeForResolution(requirement);

  if (resolvedVia === 'tag') {
    const version = metadata['dist-tags']?.[requirement.specifier];
    return version
      ? { version, resolvedVia }
      : { reason: `Tag "${requirement.specifier}" does not exist`, resolvedVia };
  }

  if (resolvedVia === 'version') {
    return metadata.versions[requirement.specifier]
      ? { version: requirement.specifier, resolvedVia }
      : { reason: `Version "${requirement.specifier}" does not exist`, resolvedVia };
  }

  const version = semver.maxSatisfying(Object.keys(metadata.versions), requirement.specifier);
  return version
    ? { version, resolvedVia }
    : { reason: `No version satisfies range "${requirement.specifier}"`, resolvedVia };
}

export function resolveRootRequirementFromMetadata(
  requirement: RootPackageRequirement,
  metadata: PackageMetadata
): { resolved?: ResolvedRootPackage; error?: ResolutionError; tagRequirement?: TagRequirement } {
  const selected = chooseVersion(requirement, metadata);

  if (!selected.version) {
    return {
      error: {
        name: requirement.name,
        raw: requirement.raw,
        reason: selected.reason ?? 'Could not resolve requirement',
        specifier: requirement.specifier,
        type: requirement.type,
      },
    };
  }

  const versionMetadata = metadata.versions[selected.version];
  if (!versionMetadata) {
    return {
      error: {
        name: requirement.name,
        raw: requirement.raw,
        reason: `Resolved version "${selected.version}" is missing from package metadata`,
        specifier: requirement.specifier,
        type: requirement.type,
      },
    };
  }

  const resolved: ResolvedRootPackage = {
    name: requirement.name,
    version: selected.version,
    dist: versionMetadata.dist,
    raw: requirement.raw,
    requiredBy: 'root',
    resolvedVia: selected.resolvedVia,
    specifier: requirement.specifier,
    type: requirement.type,
  };

  if (requirement.alias) {
    resolved.alias = requirement.alias;
  }

  if (selected.resolvedVia === 'tag') {
    return {
      resolved,
      tagRequirement: {
        name: requirement.name,
        version: selected.version,
        requiredBy: 'root',
        tag: requirement.specifier,
      },
    };
  }

  return { resolved };
}

export async function resolveRootRequirements(
  requirements: RootPackageRequirement[],
  registry: RegistryClient
): Promise<ResolveRootRequirementsResult> {
  const resolved: ResolvedRootPackage[] = [];
  const errors: ResolutionError[] = [];
  const tagRequirements: TagRequirement[] = [];

  for (const requirement of requirements) {
    try {
      const metadata = await registry.getPackageMetadata(requirement.name);
      const result = resolveRootRequirementFromMetadata(requirement, metadata);

      if (result.error) {
        errors.push(result.error);
      }

      if (result.resolved) {
        resolved.push(result.resolved);
      }

      if (result.tagRequirement) {
        tagRequirements.push(result.tagRequirement);
      }
    } catch (error) {
      errors.push({
        name: requirement.name,
        raw: requirement.raw,
        reason: (error as Error).message,
        specifier: requirement.specifier,
        type: requirement.type,
      });
    }
  }

  return { resolved, errors, tagRequirements };
}
