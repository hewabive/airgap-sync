import path from 'node:path';
import semver from 'semver';
import type { BundleManifest, DistTagsManifest, TagRequirement } from '../types.js';
import * as fs from './fs.js';

export interface StableTagResolutionIndex {
  packageVersionsByName?: Map<string, string[]>;
  rangeVersions: Map<string, string>;
  packageIds: Set<string>;
  tagVersions: Map<string, string>;
}

export interface StableRangeResolution {
  name: string;
  requiredBy: string;
  specifier: string;
  version: string;
}

const emptyStableTagResolutionIndex = (): StableTagResolutionIndex => ({
  packageVersionsByName: new Map(),
  rangeVersions: new Map(),
  packageIds: new Set(),
  tagVersions: new Map(),
});

function packageId(name: string, version: string): string {
  return `${name}@${version}`;
}

export function stableTagResolutionKey(requirement: {
  name: string;
  requiredBy: string;
  tag: string;
}): string {
  return [requirement.name, requirement.tag, requirement.requiredBy].join('\0');
}

export function stableRangeResolutionKey(requirement: {
  name: string;
  requiredBy: string;
  specifier: string;
}): string {
  return [requirement.name, requirement.specifier, requirement.requiredBy].join('\0');
}

function addPackageVersion(
  versionsByName: Map<string, string[]>,
  name: string,
  version: string
): void {
  const versions = versionsByName.get(name) ?? [];
  versions.push(version);
  versionsByName.set(name, versions);
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }

  try {
    return await fs.readJson<T>(filePath);
  } catch {
    return undefined;
  }
}

export async function readStableTagResolutionIndex(
  bundleDir: string
): Promise<StableTagResolutionIndex> {
  const [manifest, distTags] = await Promise.all([
    readOptionalJson<BundleManifest>(path.join(bundleDir, 'seed-manifest.json')),
    readOptionalJson<DistTagsManifest>(path.join(bundleDir, 'dist-tags.json')),
  ]);

  if (!manifest || !distTags) {
    return emptyStableTagResolutionIndex();
  }

  const packageIds = new Set<string>();
  const packageVersionsByName = new Map<string, string[]>();
  for (const pkg of manifest.packages) {
    if (await fs.pathExists(path.join(bundleDir, pkg.file))) {
      packageIds.add(packageId(pkg.name, pkg.version));
      addPackageVersion(packageVersionsByName, pkg.name, pkg.version);
    }
  }

  const tagVersions = new Map<string, string>();
  for (const requirement of distTags.requirements) {
    if (packageIds.has(packageId(requirement.name, requirement.version))) {
      tagVersions.set(stableTagResolutionKey(requirement), requirement.version);
    }
  }

  const rangeVersions = new Map<string, string>();
  for (const pkg of manifest.packages) {
    if (!packageIds.has(packageId(pkg.name, pkg.version))) {
      continue;
    }

    for (const reason of pkg.resolvedFrom) {
      if (
        reason.type === 'range' &&
        semver.validRange(reason.specifier) &&
        semver.satisfies(pkg.version, reason.specifier)
      ) {
        rangeVersions.set(
          stableRangeResolutionKey({
            name: pkg.name,
            requiredBy: reason.requiredBy,
            specifier: reason.specifier,
          }),
          pkg.version
        );
      }
    }
  }

  return { packageIds, packageVersionsByName, rangeVersions, tagVersions };
}

export function stableTagRequirement(
  requirement: { name: string; requiredBy: string; specifier: string },
  index: StableTagResolutionIndex
): TagRequirement | undefined {
  const version = index.tagVersions.get(
    stableTagResolutionKey({
      name: requirement.name,
      requiredBy: requirement.requiredBy,
      tag: requirement.specifier,
    })
  );

  return version
    ? {
        name: requirement.name,
        requiredBy: requirement.requiredBy,
        tag: requirement.specifier,
        version,
      }
    : undefined;
}

export function stableRangeRequirement(
  requirement: { name: string; requiredBy: string; specifier: string },
  index: StableTagResolutionIndex
): StableRangeResolution | undefined {
  const version = index.rangeVersions.get(
    stableRangeResolutionKey({
      name: requirement.name,
      requiredBy: requirement.requiredBy,
      specifier: requirement.specifier,
    })
  );

  return version
    ? {
        name: requirement.name,
        requiredBy: requirement.requiredBy,
        specifier: requirement.specifier,
        version,
      }
    : undefined;
}

export function stableBundledRangeRequirement(
  requirement: { name: string; requiredBy: string; specifier: string },
  index: StableTagResolutionIndex
): StableRangeResolution | undefined {
  const versions = index.packageVersionsByName?.get(requirement.name) ?? [];
  const version = semver.maxSatisfying(versions, requirement.specifier);

  return version
    ? {
        name: requirement.name,
        requiredBy: requirement.requiredBy,
        specifier: requirement.specifier,
        version,
      }
    : undefined;
}
