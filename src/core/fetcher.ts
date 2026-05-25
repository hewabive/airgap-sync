import { performance } from 'node:perf_hooks';
import path from 'node:path';
import type {
  FetchTimings,
  GitRequirement,
  LatestPolicy,
  PackageManifest,
  FetchPackageAction,
  RangeResolutionPolicy,
  ResolveRootRequirementsResult,
  ResolvedRootPackage,
  RootPackageRequirement,
  TagRequirement,
  TagResolutionPolicy,
  UnsupportedRootPackageRequirement,
} from '../types.js';
import type { RegistryClient } from './registry.js';
import { resolveRootRequirements } from './resolver.js';
import * as fs from './fs.js';
import { parseDependencySpec, parseGitDependencySpec } from './specs.js';
import {
  type DownloadedTarball,
  dependencySpecsFromManifest,
  downloadResolvedPackage,
} from './tarball.js';
import { packageFileName } from './files.js';
import {
  stableRangeRequirement,
  stableTagRequirement,
  type StableTagResolutionIndex,
} from './tag-resolution.js';

export interface FetchSeedBundleOptions {
  concurrency?: number;
  download?: boolean;
  includePeer?: boolean;
  latestPolicy?: LatestPolicy;
  onProgress?: (event: FetchProgressEvent) => void;
  outputDir: string;
  rangeResolutionPolicy?: RangeResolutionPolicy;
  registry: RegistryClient;
  retryDelaysMs?: number[];
  stableRequiredBy?: Set<string>;
  stableTagResolutions?: StableTagResolutionIndex;
  tagResolutionPolicy?: TagResolutionPolicy;
  tarballTimeoutMs?: number;
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
  downloadedPackages: FetchPackageAction[];
  gitRequirements: GitRequirement[];
  skipped: number;
  timings: FetchTimings;
  unsupported: UnsupportedRootPackageRequirement[];
  wouldDownload: number;
  wouldDownloadPackages: FetchPackageAction[];
}

function packageId(pkg: { name: string; version: string }): string {
  return `${pkg.name}@${pkg.version}`;
}

function isLockfileRequiredPackage(pkg: { requiredBy: string }): boolean {
  return pkg.requiredBy.startsWith('lockfile:');
}

function fetchPackageAction(
  pkg: ResolvedRootPackage,
  file = path.posix.join('packages', packageFileName(pkg.name, pkg.version))
): FetchPackageAction {
  return {
    file,
    name: pkg.name,
    raw: pkg.raw,
    requiredBy: pkg.requiredBy,
    resolvedVia: pkg.resolvedVia,
    specifier: pkg.specifier,
    type: pkg.type,
    version: pkg.version,
  };
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

function exactRequirementFromStableTag(
  requirement: RootPackageRequirement,
  tagRequirement: TagRequirement
): RootPackageRequirement {
  return {
    name: requirement.name,
    raw: `${requirement.name}@${tagRequirement.version}`,
    requiredBy: requirement.requiredBy,
    specifier: tagRequirement.version,
    type: 'version',
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
  const rangeResolutionPolicy = options.rangeResolutionPolicy ?? 'reuse-stable';
  const tagResolutionPolicy = options.tagResolutionPolicy ?? 'reuse-stable';
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 8));
  const stableTagRequirements = new Map<string, TagRequirement>();
  const stablePackageIds = options.stableTagResolutions?.packageIds ?? new Set<string>();
  const stableRequiredBy = new Set([...(options.stableRequiredBy ?? []), ...stablePackageIds]);
  const queue = options.requirements.map((requirement) => rewriteStableRequirement(requirement));
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
    downloadedPackages: [],
    skipped: 0,
    resolved: [],
    errors: [],
    gitRequirements: [...(options.gitRequirements ?? [])],
    tagRequirements: [],
    timings,
    unsupported: [...(options.unsupported ?? [])],
    wouldDownload: 0,
    wouldDownloadPackages: [],
  };
  let activeWorkers = 0;
  let drainResolved = false;
  let resolveDrain: (() => void) | undefined;

  function rewriteStableRequirement(requirement: RootPackageRequirement): RootPackageRequirement {
    if (
      rangeResolutionPolicy === 'reuse-stable' &&
      requirement.type === 'range' &&
      requirement.requiredBy !== 'root' &&
      stableRequiredBy.has(requirement.requiredBy) &&
      options.stableTagResolutions
    ) {
      const rangeRequirement = stableRangeRequirement(requirement, options.stableTagResolutions);
      if (rangeRequirement) {
        return {
          name: requirement.name,
          raw: `${requirement.name}@${rangeRequirement.version}`,
          requiredBy: requirement.requiredBy,
          specifier: rangeRequirement.version,
          type: 'version',
        };
      }
    }

    if (
      tagResolutionPolicy !== 'reuse-stable' ||
      requirement.type !== 'tag' ||
      requirement.requiredBy === 'root' ||
      !stableRequiredBy.has(requirement.requiredBy) ||
      !options.stableTagResolutions
    ) {
      return requirement;
    }

    const tagRequirement = stableTagRequirement(requirement, options.stableTagResolutions);
    if (!tagRequirement) {
      return requirement;
    }

    const exactRequirement = exactRequirementFromStableTag(requirement, tagRequirement);
    stableTagRequirements.set(requirementId(exactRequirement), tagRequirement);
    return exactRequirement;
  }

  function addTagRequirement(tagRequirement: TagRequirement): void {
    const id = tagRequirementId(tagRequirement);
    if (!tagRequirements.has(id)) {
      tagRequirements.add(id);
      result.tagRequirements.push(tagRequirement);
    }
  }

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
    queue.push(rewriteStableRequirement(requirement));
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
    const alreadyResolved = resolvedById.has(id);

    if (!alreadyResolved) {
      resolvedById.set(id, resolved);
      result.resolved.push(resolved);
      options.onProgress?.({
        current: result.resolved.length,
        package: id,
        phase: 'resolve',
        queue: queue.length,
        status: 'progress',
      });
    }

    let manifest: PackageManifest;

    try {
      manifest = manifestFromResolvedPackage(resolved);

      if (!alreadyResolved && shouldDownload) {
        const downloadStart = performance.now();
        const fetched: DownloadedTarball = await downloadResolvedPackage(
          resolved,
          options.outputDir,
          {
            existingPackageFiles,
            ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
            ...(options.tarballTimeoutMs ? { timeoutMs: options.tarballTimeoutMs } : {}),
          }
        );
        timings.downloadMs += elapsedMs(downloadStart);

        if (fetched.skipped) {
          result.skipped++;
        } else {
          result.downloaded++;
          result.downloadedPackages.push(fetchPackageAction(resolved, fetched.file));
        }
        options.onProgress?.({
          current: result.downloaded + result.skipped,
          package: id,
          phase: 'download',
          queue: queue.length,
          status: 'progress',
        });
      } else if (!alreadyResolved) {
        result.wouldDownload++;
        result.wouldDownloadPackages.push(fetchPackageAction(resolved));
      }

      if (isLockfileRequiredPackage(resolved)) {
        return;
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
        addTagRequirement(tagRequirement);
      }

      const stableTag = stableTagRequirements.get(requirementId(requirement));
      if (stableTag) {
        const resolvedStableTag = resolution.resolved.some(
          (pkg) => pkg.name === stableTag.name && pkg.version === stableTag.version
        );
        if (resolvedStableTag) {
          addTagRequirement(stableTag);
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
  result.downloadedPackages.sort(comparePackageIdentity);
  result.wouldDownloadPackages.sort(comparePackageIdentity);
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
