import semver from 'semver';
import type {
  PackageMetadata,
  ResolutionError,
  ResolutionWarning,
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

interface VersionSelection extends VersionCandidate {
  quarantineBypassed?: boolean;
}

export interface ResolveRootRequirementsOptions {
  minReleaseAgeDays?: number;
  now?: Date;
}

export function isReleaseAgeEligible(
  publishedAt: string | undefined,
  options: ResolveRootRequirementsOptions
): boolean {
  const minReleaseAgeDays = Math.max(0, options.minReleaseAgeDays ?? 0);
  if (minReleaseAgeDays === 0) {
    return true;
  }
  if (!publishedAt) {
    return false;
  }

  const cutoff = (options.now ?? new Date()).getTime() - minReleaseAgeDays * 24 * 60 * 60 * 1000;
  const publishedTime = Date.parse(publishedAt);
  return Number.isFinite(publishedTime) && publishedTime <= cutoff;
}

export function eligibleVersionNames(
  metadata: PackageMetadata,
  options: ResolveRootRequirementsOptions
): string[] {
  const minReleaseAgeDays = Math.max(0, options.minReleaseAgeDays ?? 0);
  if (minReleaseAgeDays === 0) {
    return Object.keys(metadata.versions);
  }

  return Object.keys(metadata.versions).filter((version) => {
    const publishedAt = metadata.time?.[version] ?? metadata.versions[version]?.publishedAt;
    return isReleaseAgeEligible(publishedAt, options);
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
  quarantineBypassed?: boolean;
} {
  const resolvedVia = specTypeForResolution(requirement);
  const eligibleVersions = eligibleVersionNames(metadata, options);
  const eligibleVersionSet = new Set(eligibleVersions);
  const minReleaseAgeDays = Math.max(0, options.minReleaseAgeDays ?? 0);

  if (resolvedVia === 'tag') {
    const taggedVersion = metadata['dist-tags']?.[requirement.specifier];
    if (!taggedVersion) {
      return { reason: `Tag "${requirement.specifier}" does not exist`, resolvedVia };
    }
    if (eligibleVersionSet.has(taggedVersion)) {
      return { version: taggedVersion, resolvedVia, tag: requirement.specifier };
    }
    if (requirement.specifier === 'latest') {
      const eligibleFallback = semver.maxSatisfying(eligibleVersions, '*') ?? undefined;
      if (eligibleFallback) {
        return { version: eligibleFallback, resolvedVia, tag: requirement.specifier };
      }
    }
    return {
      quarantineBypassed: minReleaseAgeDays > 0,
      version: taggedVersion,
      resolvedVia,
      tag: requirement.specifier,
    };
  }

  if (resolvedVia === 'version') {
    return metadata.versions[requirement.specifier]
      ? {
          ...(eligibleVersionSet.has(requirement.specifier) || minReleaseAgeDays === 0
            ? {}
            : { quarantineBypassed: true }),
          version: requirement.specifier,
          resolvedVia,
        }
      : { reason: `Version "${requirement.specifier}" does not exist`, resolvedVia };
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
    if (version) {
      return { version, resolvedVia };
    }
    const quarantinedVersion = semver.maxSatisfying(
      Object.keys(metadata.versions),
      requirement.specifier
    );
    return quarantinedVersion
      ? {
          quarantineBypassed: minReleaseAgeDays > 0,
          version: quarantinedVersion,
          resolvedVia,
        }
      : { reason: `No version satisfies range "${requirement.specifier}"`, resolvedVia };
  }

  function alternativeCandidates(versions: string[]): VersionCandidate[] {
    const versionSet = new Set(versions);
    return requirement.specifier
      .split('||')
      .map((part) => part.trim())
      .filter(Boolean)
      .flatMap((part): VersionCandidate[] => {
        if (semver.validRange(part)) {
          const version = semver.maxSatisfying(versions, part);
          return version ? [{ version, resolvedVia }] : [];
        }

        const taggedVersion = metadata['dist-tags']?.[part];
        return taggedVersion && versionSet.has(taggedVersion)
          ? [{ version: taggedVersion, resolvedVia: 'tag' as const, tag: part }]
          : [];
      });
  }

  const eligible = alternativeCandidates(eligibleVersions).reduce<VersionCandidate | undefined>(
    newestCandidate,
    undefined
  );
  if (eligible) {
    return eligible;
  }

  const quarantined = alternativeCandidates(Object.keys(metadata.versions)).reduce<
    VersionSelection | undefined
  >(newestCandidate, undefined);

  return quarantined
    ? { ...quarantined, quarantineBypassed: minReleaseAgeDays > 0 }
    : { reason: `No version satisfies range "${requirement.specifier}"`, resolvedVia };
}

function releaseAgeWarning(
  requirement: RootPackageRequirement,
  selected: VersionSelection,
  publishedAt: string | undefined,
  options: ResolveRootRequirementsOptions
): ResolutionWarning | undefined {
  const minReleaseAgeDays = Math.max(0, options.minReleaseAgeDays ?? 0);
  if (!selected.quarantineBypassed || minReleaseAgeDays === 0) {
    return undefined;
  }

  const publication = publishedAt
    ? `was published at ${publishedAt}`
    : 'has no registry publication timestamp';
  const dayLabel = minReleaseAgeDays === 1 ? 'day' : 'days';
  return {
    code: 'release-age-bypass',
    minReleaseAgeDays,
    name: requirement.name,
    ...(publishedAt ? { publishedAt } : {}),
    raw: requirement.raw,
    reason:
      `${requirement.name}@${selected.version} ${publication} and does not meet the ` +
      `${String(minReleaseAgeDays)} ${dayLabel} minimum release age. No eligible version can ` +
      'preserve this requirement, so the resolved version remains selected and normal integrity ' +
      'and security checks still apply.',
    requiredBy: requirement.requiredBy,
    specifier: requirement.specifier,
    type: requirement.type,
    version: selected.version,
  };
}

export function resolveRootRequirementFromMetadata(
  requirement: RootPackageRequirement,
  metadata: PackageMetadata,
  options: ResolveRootRequirementsOptions = {}
): {
  resolved?: ResolvedRootPackage;
  error?: ResolutionError;
  tagRequirement?: TagRequirement;
  warning?: ResolutionWarning;
} {
  const selected = chooseVersion(requirement, metadata, options);

  if (!selected.version) {
    return {
      error: {
        name: requirement.name,
        raw: requirement.raw,
        reason: selected.reason ?? 'Could not resolve requirement',
        requiredBy: requirement.requiredBy,
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
        requiredBy: requirement.requiredBy,
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
  const warning = releaseAgeWarning(
    requirement,
    {
      ...(selected.quarantineBypassed === undefined
        ? {}
        : { quarantineBypassed: selected.quarantineBypassed }),
      resolvedVia: selected.resolvedVia,
      ...(selected.tag === undefined ? {} : { tag: selected.tag }),
      version: selected.version,
    },
    metadata.time?.[selected.version] ?? versionMetadata.publishedAt,
    options
  );

  if (requirement.alias) {
    resolved.alias = requirement.alias;
  }

  if (selected.resolvedVia === 'tag') {
    return {
      resolved,
      ...(warning ? { warning } : {}),
      tagRequirement: {
        name: requirement.name,
        version: selected.version,
        requiredBy: requirement.requiredBy,
        tag: selected.tag ?? requirement.specifier,
      },
    };
  }

  return { resolved, ...(warning ? { warning } : {}) };
}

export async function resolveRootRequirements(
  requirements: RootPackageRequirement[],
  registry: RegistryClient,
  options: ResolveRootRequirementsOptions = {}
): Promise<ResolveRootRequirementsResult> {
  const resolved: ResolvedRootPackage[] = [];
  const errors: ResolutionError[] = [];
  const tagRequirements: TagRequirement[] = [];
  const warnings: ResolutionWarning[] = [];

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

      if (result.warning) {
        warnings.push(result.warning);
      }
    } catch (error) {
      errors.push({
        name: requirement.name,
        raw: requirement.raw,
        reason: (error as Error).message,
        requiredBy: requirement.requiredBy,
        specifier: requirement.specifier,
        type: requirement.type,
      });
    }
  }

  return { resolved, errors, tagRequirements, warnings };
}
