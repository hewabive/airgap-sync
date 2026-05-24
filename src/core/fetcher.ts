import { performance } from 'node:perf_hooks';
import path from 'node:path';
import type {
  FetchTimings,
  GitRequirement,
  LatestPolicy,
  PackageManifest,
  ResolveRootRequirementsResult,
  ResolvedRootPackage,
  RootPackageRequirement,
  UnsupportedRootPackageRequirement,
} from '../types.js';
import type { RegistryClient } from './registry.js';
import { resolveRootRequirements } from './resolver.js';
import * as fs from './fs.js';
import { isRetryableFetchError, retry } from './retry.js';
import { parseDependencySpec, parseGitDependencySpec } from './specs.js';
import {
  type DownloadedTarball,
  dependencySpecsFromManifest,
  downloadResolvedPackage,
} from './tarball.js';

export interface FetchSeedBundleOptions {
  concurrency?: number;
  download?: boolean;
  includePeer?: boolean;
  latestPolicy?: LatestPolicy;
  onProgress?: (event: FetchProgressEvent) => void;
  outputDir: string;
  registry: RegistryClient;
  gitRequirements?: GitRequirement[];
  requirements: RootPackageRequirement[];
  unsupported?: UnsupportedRootPackageRequirement[];
}

export type FetchProgressPhase = 'resolve' | 'download' | 'scan';
export type FetchProgressStatus = 'start' | 'progress' | 'done' | 'error';

export interface FetchProgressEvent {
  current?: number;
  package?: string;
  phase: FetchProgressPhase;
  queue?: number;
  status: FetchProgressStatus;
}

export interface FetchSeedBundleResult extends ResolveRootRequirementsResult {
  downloaded: number;
  gitRequirements: GitRequirement[];
  skipped: number;
  timings: FetchTimings;
  unsupported: UnsupportedRootPackageRequirement[];
  wouldDownload: number;
}

function packageId(pkg: { name: string; version: string }): string {
  return `${pkg.name}@${pkg.version}`;
}

function comparePackageIdentity(
  left: { name: string; version: string },
  right: { name: string; version: string }
): number {
  return left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
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

function compareTagRequirement(
  left: { name: string; requiredBy: string; tag: string; version: string },
  right: { name: string; requiredBy: string; tag: string; version: string }
): number {
  return (
    left.name.localeCompare(right.name) ||
    left.tag.localeCompare(right.tag) ||
    left.version.localeCompare(right.version) ||
    left.requiredBy.localeCompare(right.requiredBy)
  );
}

function compareUnsupportedRequirement(
  left: UnsupportedRootPackageRequirement,
  right: UnsupportedRootPackageRequirement
): number {
  return unsupportedId(left).localeCompare(unsupportedId(right));
}

function unsupportedId(requirement: UnsupportedRootPackageRequirement): string {
  return [requirement.requiredBy, requirement.raw, requirement.type, requirement.reason].join('\0');
}

function compareGitRequirement(left: GitRequirement, right: GitRequirement): number {
  return gitRequirementId(left).localeCompare(gitRequirementId(right));
}

function gitRequirementId(requirement: GitRequirement): string {
  return [requirement.requiredBy, requirement.raw, requirement.rawSpec].join('\0');
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

function createFetchTimings(): FetchTimings {
  return {
    dependencyScanMs: 0,
    downloadMs: 0,
    manifestReadMs: 0,
    resolveMs: 0,
    totalMs: 0,
  };
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  }

  return String(error);
}

function manifestFromResolvedPackage(pkg: ResolvedRootPackage): PackageManifest {
  return {
    name: pkg.name,
    version: pkg.version,
    ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
    ...(pkg.optionalDependencies ? { optionalDependencies: pkg.optionalDependencies } : {}),
    ...(pkg.peerDependencies ? { peerDependencies: pkg.peerDependencies } : {}),
    ...(pkg.peerDependenciesMeta ? { peerDependenciesMeta: pkg.peerDependenciesMeta } : {}),
  };
}

async function readExistingPackageFiles(outputDir: string): Promise<Set<string>> {
  const packageDir = path.join(outputDir, 'packages');

  try {
    const entries = await fs.readdir(packageDir);
    return new Set(entries.filter((entry) => entry.endsWith('.tgz')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
}

export async function fetchSeedBundle(
  options: FetchSeedBundleOptions
): Promise<FetchSeedBundleResult> {
  const totalStart = performance.now();
  const shouldDownload = options.download !== false;
  const latestPolicy = options.latestPolicy ?? 'bundled';
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 16));
  const queue = [...options.requirements];
  const latestRequirements = new Set<string>();
  const processedRequirements = new Set<string>();
  const scannedPackages = new Set<string>();
  const resolvedById = new Map<string, ResolvedRootPackage>();
  const tagRequirements = new Set<string>();
  const timings = createFetchTimings();
  const existingPackageFiles = shouldDownload
    ? await readExistingPackageFiles(options.outputDir)
    : new Set<string>();
  const result: FetchSeedBundleResult = {
    downloaded: 0,
    skipped: 0,
    resolved: [],
    errors: [],
    gitRequirements: [...(options.gitRequirements ?? [])],
    tagRequirements: [],
    timings,
    unsupported: [...(options.unsupported ?? [])],
    wouldDownload: 0,
  };
  let activeWorkers = 0;
  let drainResolved = false;
  let resolveDrain: (() => void) | undefined;

  options.onProgress?.({
    current: 0,
    phase: 'resolve',
    queue: queue.length,
    status: 'start',
  });

  function maybeResolveDrain(): void {
    if (!drainResolved && activeWorkers === 0 && queue.length === 0) {
      drainResolved = true;
      resolveDrain?.();
    }
  }

  function enqueueRequirement(requirement: RootPackageRequirement): void {
    queue.push(requirement);
    scheduleWorkers();
  }

  function dequeueUnprocessedRequirement(): RootPackageRequirement | undefined {
    for (;;) {
      const requirement = queue.shift();
      if (!requirement) {
        return undefined;
      }

      const reqId = requirementId(requirement);
      if (processedRequirements.has(reqId)) {
        continue;
      }
      processedRequirements.add(reqId);
      return requirement;
    }
  }

  function scheduleWorkers(): void {
    if (drainResolved) {
      return;
    }

    while (activeWorkers < concurrency) {
      const requirement = dequeueUnprocessedRequirement();
      if (!requirement) {
        break;
      }

      activeWorkers++;
      void processRequirement(requirement).finally(() => {
        activeWorkers--;
        scheduleWorkers();
        maybeResolveDrain();
      });
    }

    maybeResolveDrain();
  }

  async function processResolvedPackage(resolved: ResolvedRootPackage): Promise<void> {
    if (!latestRequirements.has(resolved.name)) {
      latestRequirements.add(resolved.name);

      if (
        latestPolicy === 'source' &&
        !(resolved.resolvedVia === 'tag' && resolved.specifier === 'latest')
      ) {
        enqueueRequirement(publishLatestRequirement(resolved.name));
      }
    }

    const id = packageId(resolved);
    if (resolvedById.has(id)) {
      return;
    }

    resolvedById.set(id, resolved);
    result.resolved.push(resolved);
    options.onProgress?.({
      current: result.resolved.length,
      package: id,
      phase: 'resolve',
      queue: queue.length,
      status: 'progress',
    });

    let manifest: PackageManifest;

    try {
      manifest = manifestFromResolvedPackage(resolved);

      if (shouldDownload) {
        const fetched = await retry(
          async (): Promise<DownloadedTarball> => {
            const downloadStart = performance.now();
            const downloadedTarball = await downloadResolvedPackage(resolved, options.outputDir, {
              existingPackageFiles,
            });
            timings.downloadMs += elapsedMs(downloadStart);
            return downloadedTarball;
          },
          { isRetryable: isRetryableFetchError }
        );

        if (fetched.skipped) {
          result.skipped++;
        } else {
          result.downloaded++;
        }
        options.onProgress?.({
          current: result.downloaded + result.skipped,
          package: id,
          phase: 'download',
          queue: queue.length,
          status: 'progress',
        });
      } else {
        result.wouldDownload++;
      }

      if (scannedPackages.has(id)) {
        return;
      }
      scannedPackages.add(id);

      const requiredBy = packageId(manifest);
      const dependencyScanStart = performance.now();
      const dependencies = dependencySpecsFromManifest(manifest, {
        includePeer: options.includePeer === true,
      });

      for (const [name, specifier] of Object.entries(dependencies)) {
        const parsed = parseDependencySpec(name, specifier, requiredBy);
        if ('reason' in parsed) {
          const gitRequirement = parseGitDependencySpec(name, specifier, requiredBy);
          if (gitRequirement) {
            result.gitRequirements.push(gitRequirement);
            options.onProgress?.({
              current: result.gitRequirements.length,
              package: requiredBy,
              phase: 'scan',
              queue: queue.length,
              status: 'progress',
            });
            continue;
          }
          result.unsupported.push(parsed);
        } else {
          enqueueRequirement(parsed);
        }
      }
      timings.dependencyScanMs += elapsedMs(dependencyScanStart);
    } catch (error) {
      result.errors.push({
        name: resolved.name,
        raw: resolved.raw,
        reason: errorMessage(error),
        specifier: resolved.specifier,
        type: resolved.type,
      });
      options.onProgress?.({
        current: result.downloaded + result.skipped,
        package: id,
        phase: shouldDownload ? 'download' : 'scan',
        queue: queue.length,
        status: 'error',
      });
      return;
    }
  }

  async function processRequirement(requirement: RootPackageRequirement): Promise<void> {
    try {
      const resolveStart = performance.now();
      const resolution = await resolveRootRequirements([requirement], options.registry);
      timings.resolveMs += elapsedMs(resolveStart);
      result.errors.push(...resolution.errors);
      if (resolution.errors.length > 0) {
        options.onProgress?.({
          package: requirement.raw,
          phase: 'resolve',
          queue: queue.length,
          status: 'error',
        });
      }

      for (const tagRequirement of resolution.tagRequirements) {
        const id = tagRequirementId(tagRequirement);
        if (!tagRequirements.has(id)) {
          tagRequirements.add(id);
          result.tagRequirements.push(tagRequirement);
        }
      }

      await Promise.all(resolution.resolved.map((resolved) => processResolvedPackage(resolved)));
    } catch (error) {
      result.errors.push({
        name: requirement.name,
        raw: requirement.raw,
        reason: errorMessage(error),
        specifier: requirement.specifier,
        type: requirement.type,
      });
      options.onProgress?.({
        package: requirement.raw,
        phase: 'resolve',
        queue: queue.length,
        status: 'error',
      });
    }
  }

  await new Promise<void>((resolve) => {
    resolveDrain = resolve;
    scheduleWorkers();
  });

  result.resolved.sort(comparePackageIdentity);
  result.tagRequirements.sort(compareTagRequirement);
  result.gitRequirements.sort(compareGitRequirement);
  result.unsupported.sort(compareUnsupportedRequirement);

  timings.totalMs = elapsedMs(totalStart);
  options.onProgress?.({
    current: result.resolved.length,
    phase: 'resolve',
    queue: 0,
    status: 'done',
  });
  return result;
}
