import { performance } from 'node:perf_hooks';
import type {
  FetchTimings,
  GitRequirement,
  PackageManifest,
  ResolveRootRequirementsResult,
  ResolvedRootPackage,
  RootPackageRequirement,
  UnsupportedRootPackageRequirement,
} from '../types.js';
import type { RegistryClient } from './registry.js';
import { resolveRootRequirements } from './resolver.js';
import { parseDependencySpec, parseGitDependencySpec } from './specs.js';
import {
  dependencySpecsFromManifest,
  downloadResolvedPackage,
  readPackageManifest,
} from './tarball.js';

export interface FetchSeedBundleOptions {
  concurrency?: number;
  download?: boolean;
  includePeer?: boolean;
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
  const totalStart = performance.now();
  const shouldDownload = options.download !== false;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 16));
  const queue = [...options.requirements];
  const latestRequirements = new Set<string>();
  const processedRequirements = new Set<string>();
  const scannedPackages = new Set<string>();
  const resolvedById = new Map<string, ResolvedRootPackage>();
  const tagRequirements = new Set<string>();
  const timings = createFetchTimings();
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

      if (!(resolved.resolvedVia === 'tag' && resolved.specifier === 'latest')) {
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

    if (shouldDownload) {
      const downloadStart = performance.now();
      const downloaded = await downloadResolvedPackage(resolved, options.outputDir);
      timings.downloadMs += elapsedMs(downloadStart);
      if (downloaded.skipped) {
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
      const manifestStart = performance.now();
      manifest = await readPackageManifest(downloaded.path);
      timings.manifestReadMs += elapsedMs(manifestStart);
    } else {
      result.wouldDownload++;
      const manifestStart = performance.now();
      manifest = await manifestFromRegistry(resolved, options.registry);
      timings.manifestReadMs += elapsedMs(manifestStart);
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
  }

  async function processRequirement(requirement: RootPackageRequirement): Promise<void> {
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
