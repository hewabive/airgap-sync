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

interface VersionCandidate {
  resolvedVia: Exclude<RootPackageRequirement['type'], 'alias'>;
  tag?: string;
  version: string;
}

export interface ResolveRootRequirementsOptions {
  minReleaseAgeDays?: number;
  now?: Date;
}

function eligibleVersionNames(
  metadata: PackageMetadata,
  options: ResolveRootRequirementsOptions
): string[] {
  const minReleaseAgeDays = Math.max(0, options.minReleaseAgeDays ?? 0);
  if (minReleaseAgeDays === 0) {
    return Object.keys(metadata.versions);
  }

  const cutoff = (options.now ?? new Date()).getTime() - minReleaseAgeDays * 24 * 60 * 60 * 1000;
  return Object.keys(metadata.versions).filter((version) => {
    const publishedAt = metadata.time?.[version] ?? metadata.versions[version]?.publishedAt;
    if (!publishedAt) return false;
    const publishedTime = Date.parse(publishedAt);
    return Number.isFinite(publishedTime) && publishedTime <= cutoff;
  });
}

function newestCandidate(
  best: VersionCandidate | undefined,
  candidate: VersionCandidate
): VersionCandidate {
  if (!best) {
    return candidate;
  }

  const bestVersion = semver.valid(best.version);
  const candidateVersion = semver.valid(candidate.version);
  if (bestVersion && candidateVersion) {
    return semver.gt(candidateVersion, bestVersion) ? candidate : best;
  }

  if (candidateVersion && !bestVersion) {
    return candidate;
  }

  if (!candidateVersion && !bestVersion && candidate.version.localeCompare(best.version) > 0) {
    return candidate;
  }

  return best;
}

function chooseVersion(
  requirement: RootPackageRequirement,
  metadata: PackageMetadata,
  options: ResolveRootRequirementsOptions = {}
): {
  version?: string;
  reason?: string;
  resolvedVia: Exclude<RootPackageRequirement['type'], 'alias'>;
  tag?: string;
} {
  const resolvedVia = specTypeForResolution(requirement);
  const eligibleVersions = eligibleVersionNames(metadata, options);
  const eligibleVersionSet = new Set(eligibleVersions);
  const minReleaseAgeDays = Math.max(0, options.minReleaseAgeDays ?? 0);

  if (resolvedVia === 'tag') {
    const taggedVersion = metadata['dist-tags']?.[requirement.specifier];
    const version =
      taggedVersion && eligibleVersionSet.has(taggedVersion)
        ? taggedVersion
        : requirement.specifier === 'latest'
          ? (semver.maxSatisfying(eligibleVersions, '*') ?? undefined)
          : undefined;
    return version
      ? { version, resolvedVia, tag: requirement.specifier }
      : {
          reason: taggedVersion
            ? `Tag "${requirement.specifier}" points to a release newer than the ${String(minReleaseAgeDays)} day minimum age`
            : `Tag "${requirement.specifier}" does not exist`,
          resolvedVia,
        };
  }

  if (resolvedVia === 'version') {
    return metadata.versions[requirement.specifier] && eligibleVersionSet.has(requirement.specifier)
      ? { version: requirement.specifier, resolvedVia }
      : {
          reason: metadata.versions[requirement.specifier]
            ? `Version "${requirement.specifier}" is newer than the ${String(minReleaseAgeDays)} day minimum age or has no publication timestamp`
            : `Version "${requirement.specifier}" does not exist`,
          resolvedVia,
        };
  }

  const validRange = semver.validRange(requirement.specifier);
  if (validRange) {
    const latest = metadata['dist-tags']?.latest;
    if (
      latest &&
      eligibleVersionSet.has(latest) &&
      semver.satisfies(latest, requirement.specifier)
    ) {
      return { version: latest, resolvedVia };
    }

    const version = semver.maxSatisfying(eligibleVersions, requirement.specifier);
    return version
      ? { version, resolvedVia }
      : { reason: `No version satisfies range "${requirement.specifier}"`, resolvedVia };
  }

  const candidates: VersionCandidate[] = requirement.specifier
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part): VersionCandidate[] => {
      if (semver.validRange(part)) {
        const version = semver.maxSatisfying(eligibleVersions, part);
        return version ? [{ version, resolvedVia }] : [];
      }

      const taggedVersion = metadata['dist-tags']?.[part];
      return taggedVersion
        ? eligibleVersionSet.has(taggedVersion)
          ? [{ version: taggedVersion, resolvedVia: 'tag' as const, tag: part }]
          : []
        : [];
    });

  const version = candidates.reduce<VersionCandidate | undefined>(newestCandidate, undefined);

  return (
    version ?? { reason: `No version satisfies range "${requirement.specifier}"`, resolvedVia }
  );
}

export function resolveRootRequirementFromMetadata(
  requirement: RootPackageRequirement,
  metadata: PackageMetadata,
  options: ResolveRootRequirementsOptions = {}
): { resolved?: ResolvedRootPackage; error?: ResolutionError; tagRequirement?: TagRequirement } {
  const selected = chooseVersion(requirement, metadata, options);

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
    ...(versionMetadata.dependencies ? { dependencies: versionMetadata.dependencies } : {}),
    dist: versionMetadata.dist,
    ...(versionMetadata.optionalDependencies
      ? { optionalDependencies: versionMetadata.optionalDependencies }
      : {}),
    ...(versionMetadata.peerDependencies
      ? { peerDependencies: versionMetadata.peerDependencies }
      : {}),
    ...(versionMetadata.peerDependenciesMeta
      ? { peerDependenciesMeta: versionMetadata.peerDependenciesMeta }
      : {}),
    ...((metadata.time?.[selected.version] ?? versionMetadata.publishedAt)
      ? { publishedAt: metadata.time?.[selected.version] ?? versionMetadata.publishedAt }
      : {}),
    raw: requirement.raw,
    requiredBy: requirement.requiredBy,
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
        requiredBy: requirement.requiredBy,
        tag: selected.tag ?? requirement.specifier,
      },
    };
  }

  return { resolved };
}

export async function resolveRootRequirements(
  requirements: RootPackageRequirement[],
  registry: RegistryClient,
  options: ResolveRootRequirementsOptions = {}
): Promise<ResolveRootRequirementsResult> {
  const resolved: ResolvedRootPackage[] = [];
  const errors: ResolutionError[] = [];
  const tagRequirements: TagRequirement[] = [];

  for (const requirement of requirements) {
    try {
      const metadata = await registry.getPackageMetadata(requirement.name);
      const result = resolveRootRequirementFromMetadata(requirement, metadata, options);

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
