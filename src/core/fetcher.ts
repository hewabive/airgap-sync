import type {
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

export async function fetchSeedBundle(
  options: FetchSeedBundleOptions
): Promise<FetchSeedBundleResult> {
  const queue = [...options.requirements];
  const processedRequirements = new Set<string>();
  const scannedPackages = new Set<string>();
  const resolvedById = new Map<string, ResolvedRootPackage>();
  const result: FetchSeedBundleResult = {
    downloaded: 0,
    skipped: 0,
    resolved: [],
    errors: [],
    tagRequirements: [],
    unsupported: [...(options.unsupported ?? [])],
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
    result.tagRequirements.push(...resolution.tagRequirements);

    for (const resolved of resolution.resolved) {
      const id = packageId(resolved);
      if (resolvedById.has(id)) {
        continue;
      }

      resolvedById.set(id, resolved);
      result.resolved.push(resolved);

      const downloaded = await downloadResolvedPackage(resolved, options.outputDir);
      if (downloaded.skipped) {
        result.skipped++;
      } else {
        result.downloaded++;
      }

      if (scannedPackages.has(id)) {
        continue;
      }
      scannedPackages.add(id);

      const manifest = await readPackageManifest(downloaded.path);
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
