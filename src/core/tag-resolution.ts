import path from 'node:path';
import semver from 'semver';
import type { BundleManifest, DistTagsManifest, TagRequirement } from '../types.js';
import * as fs from './fs.js';

export interface StableTagResolutionIndex {
  packagePublishedAt?: Map<string, string>;
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
  packagePublishedAt: new Map(),
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

async function readPackageFiles(bundleDir: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(path.join(bundleDir, 'packages'));
    return new Set(entries.map((entry) => path.posix.join('packages', entry)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
}

export async function readStableTagResolutionIndex(
  bundleDir: string
): Promise<StableTagResolutionIndex> {
  const [manifest, distTags, packageFiles] = await Promise.all([
    readOptionalJson<BundleManifest>(path.join(bundleDir, 'seed-manifest.json')),
    readOptionalJson<DistTagsManifest>(path.join(bundleDir, 'dist-tags.json')),
    readPackageFiles(bundleDir),
  ]);

  if (!manifest || !distTags) {
    return emptyStableTagResolutionIndex();
  }

  const packageIds = new Set<string>();
  const packagePublishedAt = new Map<string, string>();
  const packageVersionsByName = new Map<string, string[]>();
  for (const pkg of manifest.packages) {
    if (packageFiles.has(pkg.file)) {
      const id = packageId(pkg.name, pkg.version);
      packageIds.add(id);
      addPackageVersion(packageVersionsByName, pkg.name, pkg.version);
      if (pkg.publishedAt) {
        packagePublishedAt.set(id, pkg.publishedAt);
      }
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

  return {
    packageIds,
    packagePublishedAt,
    packageVersionsByName,
    rangeVersions,
    tagVersions,
  };
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
