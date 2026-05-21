import type {
  PackageManifest,
  ResolveRootRequirementsResult,
  ResolvedRootPackage,
  RootPackageRequirement,
  UnsupportedRootPackageRequirement,
} from '../types.js';
import type { RegistryClient } from './registry.js';
import { resolveRootRequirements } from './resolver.js';
import { parseDependencySpec } from './specs.js';
import {
  dependencySpecsFromManifest,
  downloadResolvedPackage,
  readPackageManifest,
} from './tarball.js';

export interface FetchSeedBundleOptions {
  download?: boolean;
  includePeer?: boolean;
  outputDir: string;
  registry: RegistryClient;
  requirements: RootPackageRequirement[];
  unsupported?: UnsupportedRootPackageRequirement[];
}

export interface FetchSeedBundleResult extends ResolveRootRequirementsResult {
  downloaded: number;
  skipped: number;
  unsupported: UnsupportedRootPackageRequirement[];
  wouldDownload: number;
}

function packageId(pkg: { name: string; version: string }): string {
  return `${pkg.name}@${pkg.version}`;
}

function requirementId(requirement: RootPackageRequirement): string {
  return [
    requirement.requiredBy,
    requirement.name,
    requirement.specifier,
    requirement.type,
    requirement.alias ?? '',
  ].join('\0');
}

function tagRequirementId(requirement: { name: string; tag: string; version: string }): string {
  return [requirement.name, requirement.tag, requirement.version].join('\0');
}

function publishLatestRequirement(name: string): RootPackageRequirement {
  return {
    name,
    raw: `${name}@latest`,
    requiredBy: 'airgap-sync:publish-latest',
    specifier: 'latest',
    type: 'tag',
  };
}

async function manifestFromRegistry(
  pkg: ResolvedRootPackage,
  registry: RegistryClient
): Promise<PackageManifest> {
  const metadata = await registry.getPackageMetadata(pkg.name);
  const versionMetadata = metadata.versions[pkg.version];

  if (!versionMetadata) {
    throw new Error(`${packageId(pkg)} is missing from registry metadata`);
  }

  return {
    name: versionMetadata.name,
    version: versionMetadata.version,
    ...(versionMetadata.dependencies ? { dependencies: versionMetadata.dependencies } : {}),
    ...(versionMetadata.optionalDependencies
      ? { optionalDependencies: versionMetadata.optionalDependencies }
      : {}),
    ...(versionMetadata.peerDependencies
      ? { peerDependencies: versionMetadata.peerDependencies }
      : {}),
  };
}

export async function fetchSeedBundle(
  options: FetchSeedBundleOptions
): Promise<FetchSeedBundleResult> {
  const shouldDownload = options.download !== false;
  const queue = [...options.requirements];
  const latestRequirements = new Set<string>();
  const processedRequirements = new Set<string>();
  const scannedPackages = new Set<string>();
  const resolvedById = new Map<string, ResolvedRootPackage>();
  const tagRequirements = new Set<string>();
  const result: FetchSeedBundleResult = {
    downloaded: 0,
    skipped: 0,
    resolved: [],
    errors: [],
    tagRequirements: [],
    unsupported: [...(options.unsupported ?? [])],
    wouldDownload: 0,
  };

  while (queue.length > 0) {
    const requirement = queue.shift();
    if (!requirement) continue;

    const reqId = requirementId(requirement);
    if (processedRequirements.has(reqId)) {
      continue;
    }
    processedRequirements.add(reqId);

    const resolution = await resolveRootRequirements([requirement], options.registry);
    result.errors.push(...resolution.errors);

    for (const tagRequirement of resolution.tagRequirements) {
      const id = tagRequirementId(tagRequirement);
      if (!tagRequirements.has(id)) {
        tagRequirements.add(id);
        result.tagRequirements.push(tagRequirement);
      }
    }

    for (const resolved of resolution.resolved) {
      if (!latestRequirements.has(resolved.name)) {
        latestRequirements.add(resolved.name);

        if (!(resolved.resolvedVia === 'tag' && resolved.specifier === 'latest')) {
          queue.push(publishLatestRequirement(resolved.name));
        }
      }

      const id = packageId(resolved);
      if (resolvedById.has(id)) {
        continue;
      }

      resolvedById.set(id, resolved);
      result.resolved.push(resolved);

      let manifest: PackageManifest;

      if (shouldDownload) {
        const downloaded = await downloadResolvedPackage(resolved, options.outputDir);
        if (downloaded.skipped) {
          result.skipped++;
        } else {
          result.downloaded++;
        }
        manifest = await readPackageManifest(downloaded.path);
      } else {
        result.wouldDownload++;
        manifest = await manifestFromRegistry(resolved, options.registry);
      }

      if (scannedPackages.has(id)) {
        continue;
      }
      scannedPackages.add(id);

      const requiredBy = packageId(manifest);
      const dependencies = dependencySpecsFromManifest(manifest, {
        includePeer: options.includePeer === true,
      });

      for (const [name, specifier] of Object.entries(dependencies)) {
        const parsed = parseDependencySpec(name, specifier, requiredBy);
        if ('reason' in parsed) {
          result.unsupported.push(parsed);
        } else {
          queue.push(parsed);
        }
      }
    }
  }

  return result;
}
