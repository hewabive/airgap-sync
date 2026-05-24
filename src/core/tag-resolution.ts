import path from 'node:path';
import type { BundleManifest, DistTagsManifest, TagRequirement } from '../types.js';
import * as fs from './fs.js';

export interface StableTagResolutionIndex {
  packageIds: Set<string>;
  tagVersions: Map<string, string>;
}

const emptyStableTagResolutionIndex = (): StableTagResolutionIndex => ({
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
  for (const pkg of manifest.packages) {
    if (await fs.pathExists(path.join(bundleDir, pkg.file))) {
      packageIds.add(packageId(pkg.name, pkg.version));
    }
  }

  const tagVersions = new Map<string, string>();
  for (const requirement of distTags.requirements) {
    if (packageIds.has(packageId(requirement.name, requirement.version))) {
      tagVersions.set(stableTagResolutionKey(requirement), requirement.version);
    }
  }

  return { packageIds, tagVersions };
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
