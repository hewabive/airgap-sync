import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as fs from './fs.js';
import type {
  CollectGitManifestScanError,
  CollectIterationReport,
  CollectReport,
  CollectTimings,
  FetchReport,
  GitFetchReport,
  GitRequirement,
  GitSource,
  LatestPolicy,
  RangeResolutionPolicy,
  RepositoryUpdateReport,
  RootPackageRequirement,
  TagResolutionPolicy,
  UnsupportedRootPackageRequirement,
} from '../types.js';
import {
  createBundleDocuments,
  createFetchReport,
  writeBundleDocuments,
  writeCollectReport,
  writeFetchReport,
  writeGitFetchReport,
} from './bundle.js';
import { fetchSeedBundle, type FetchSeedBundleResult } from './fetcher.js';
import type { FetchProgressEvent } from './fetcher.js';
import { fetchGitSources, type GitCommandRunner } from './git-fetch.js';
import type { GitFetchProgressEvent } from './git-fetch.js';
import { readGitSourceManifestRequirements } from './git-manifests.js';
import { createGitSourcesManifest, writeGitSourcesManifest } from './git-sources.js';
import { gitSourceMirrorPath } from './git-targets.js';
import { readLockfileRequirements } from './lockfiles.js';
import { readManifestRequirements } from './manifests.js';
import { readRegistryMetadataCache, writeRegistryMetadataCache } from './metadata-cache.js';
import { aggregateFetchReports, aggregateGitFetchReports } from './report-aggregation.js';
import type { RegistryClient } from './registry.js';
import { type GitOutputCommandRunner, updateRepositories } from './repos.js';
import type { RepositoryUpdateProgressEvent } from './repos.js';
import { readStableTagResolutionIndex } from './tag-resolution.js';

export interface CollectBundleOptions {
  concurrency?: number;
  dryRun?: boolean;
  generatedAt?: string;
  includeDev?: boolean;
  includePeer?: boolean;
  initialGitRequirements?: GitRequirement[];
  initialGitSources?: GitSource[];
  initialRequirements?: RootPackageRequirement[];
  initialUnsupported?: UnsupportedRootPackageRequirement[];
  latestPolicy?: LatestPolicy;
  maxIterations?: number;
  onProgress?: (event: CollectProgressEvent) => void;
  outputDir: string;
  rangeResolutionPolicy?: RangeResolutionPolicy;
  registry: RegistryClient;
  registryUrl: string;
  retryDelaysMs?: number[];
  root?: string;
  runGitCommand?: GitCommandRunner;
  runGitOutputCommand?: GitOutputCommandRunner;
  tagResolutionPolicy?: TagResolutionPolicy;
  tarballTimeoutMs?: number;
}

export type CollectProgressPhase =
  | 'repository-update'
  | 'manifest-scan'
  | 'lockfile-scan'
  | 'npm-fetch'
  | 'git-fetch'
  | 'git-manifest-scan'
  | 'bundle-write';

export type CollectProgressStatus = 'start' | 'progress' | 'done' | 'error';

export interface CollectProgressEvent {
  current?: number;
  detail?: string;
  iteration?: number;
  phase: CollectProgressPhase;
  queue?: number;
  status: CollectProgressStatus;
  total?: number;
}

interface RequirementState {
  gitRequirements: GitRequirement[];
  requirements: RootPackageRequirement[];
  unsupported: UnsupportedRootPackageRequirement[];
}

function createCollectTimings(): CollectTimings {
  return {
    bundleDocumentsMs: 0,
    fetchIterationsMs: 0,
    gitFetchMs: 0,
    gitManifestScanMs: 0,
    lockfileScanMs: 0,
    manifestScanMs: 0,
    repositoryUpdateMs: 0,
    reportWriteMs: 0,
    totalMs: 0,
  };
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

function requirementKey(requirement: RootPackageRequirement): string {
  return [
    requirement.requiredBy,
    requirement.name,
    requirement.specifier,
    requirement.type,
    requirement.alias ?? '',
  ].join('\0');
}

function gitRequirementKey(requirement: GitRequirement): string {
  return [requirement.requiredBy, requirement.raw, requirement.rawSpec].join('\0');
}

function unsupportedKey(requirement: UnsupportedRootPackageRequirement): string {
  return [requirement.requiredBy, requirement.raw, requirement.type, requirement.reason].join('\0');
}

function addUnique<T>(
  items: T[],
  seen: Set<string>,
  values: T[],
  key: (value: T) => string
): number {
  let added = 0;

  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    items.push(value);
    added++;
  }

  return added;
}

function sourceIds(sources: GitSource[]): Set<string> {
  return new Set(sources.map((source) => source.id));
}

function gitSourcesFetchKey(sources: GitSource[]): string {
  return JSON.stringify(
    sources
      .map((source) => ({
        committish: source.committish ?? '',
        fetchSpec: source.fetchSpec ?? '',
        gitRange: source.gitRange ?? '',
        gitSubdir: source.gitSubdir ?? '',
        id: source.id,
        localMirrorPath: source.localMirrorPath,
        sourceUrl: source.sourceUrl,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
}

function formatGitFetchProgressDetail(event: GitFetchProgressEvent): string | undefined {
  if (!event.action) {
    return event.repository;
  }

  const action = event.action;
  const parts = [action.repository, action.status];
  if (action.status === 'updated') {
    if (action.changed === false) {
      parts.push('unchanged');
    } else if (action.changed === true) {
      parts.push('changed');
    }
  }
  if (action.newCommits !== undefined) {
    parts.push(`+${String(action.newCommits)} commits`);
  }
  const refChanges =
    (action.addedRefs ?? 0) + (action.updatedRefs ?? 0) + (action.deletedRefs ?? 0);
  if (refChanges > 0) {
    parts.push(
      `refs +${String(action.addedRefs ?? 0)}/~${String(action.updatedRefs ?? 0)}/-${String(action.deletedRefs ?? 0)}`
    );
  }
  if (action.error) {
    parts.push(action.error);
  }

  return parts.join(' ');
}

function emptyRepositoryUpdateReport(options: {
  dryRun: boolean;
  generatedAt: string;
  root: string;
}): RepositoryUpdateReport {
  return {
    detached: 0,
    dirty: 0,
    dryRun: options.dryRun,
    errors: [],
    generatedAt: options.generatedAt,
    planned: 0,
    repositories: [],
    root: options.root,
    totalRepositories: 0,
    updated: 0,
  };
}

function emptyGitFetchReport(options: {
  dryRun: boolean;
  generatedAt: string;
  mirrorsDir: string;
}): GitFetchReport {
  return {
    actions: [],
    changed: 0,
    cloned: 0,
    dryRun: options.dryRun,
    errors: [],
    generatedAt: options.generatedAt,
    mirrorsDir: options.mirrorsDir,
    planned: 0,
    totalRepositories: 0,
    unchanged: 0,
    updated: 0,
  };
}

async function scanGitSourceManifests(options: {
  bundleDir: string;
  includeDev: boolean;
  includePeer: boolean;
  runGitOutputCommand?: GitOutputCommandRunner;
  scannedSourceIds: Set<string>;
  sources: GitSource[];
  unchangedSourceIds?: Set<string>;
}): Promise<{
  errors: CollectGitManifestScanError[];
  scanned: number;
  stableRequiredBy: Set<string>;
  state: RequirementState;
}> {
  const errors: CollectGitManifestScanError[] = [];
  const stableRequiredBy = new Set<string>();
  const state: RequirementState = {
    gitRequirements: [],
    requirements: [],
    unsupported: [],
  };
  let scanned = 0;

  for (const source of options.sources) {
    if (options.scannedSourceIds.has(source.id)) {
      continue;
    }

    const mirrorPath = gitSourceMirrorPath({
      bundleDir: options.bundleDir,
      source,
    });
    if (!(await fs.pathExists(mirrorPath))) {
      errors.push({
        error: 'Local Git mirror does not exist',
        mirrorPath,
        sourceId: source.id,
      });
      continue;
    }

    try {
      const result = await readGitSourceManifestRequirements({
        includeDev: options.includeDev,
        includePeer: options.includePeer,
        mirrorPath,
        ...(options.runGitOutputCommand ? { runner: options.runGitOutputCommand } : {}),
        source,
      });
      options.scannedSourceIds.add(source.id);
      scanned++;
      if (options.unchangedSourceIds?.has(source.id)) {
        for (const requirement of result.requirements) {
          stableRequiredBy.add(requirement.requiredBy);
        }
      }
      state.requirements.push(...result.requirements);
      state.gitRequirements.push(...result.gitRequirements);
      state.unsupported.push(...result.unsupported);
    } catch (error) {
      errors.push({
        error: (error as Error).message,
        mirrorPath,
        sourceId: source.id,
      });
    }
  }

  return { errors, scanned, stableRequiredBy, state };
}

export async function collectBundle(options: CollectBundleOptions): Promise<CollectReport> {
  const totalStart = performance.now();
  const timings = createCollectTimings();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const root = options.root ? path.resolve(options.root) : undefined;
  const outputDir = path.resolve(options.outputDir);
  const dryRun = options.dryRun === true;
  const includeDev = options.includeDev === true;
  const includePeer = options.includePeer === true;
  const maxIterations = options.maxIterations ?? 10;
  const tagResolutionPolicy = options.tagResolutionPolicy ?? 'reuse-stable';
  const stableTagResolutions = await readStableTagResolutionIndex(outputDir);
  const metadataCache = await readRegistryMetadataCache(outputDir);
  const stableRequiredBy = new Set<string>();

  const repositoryUpdateStart = performance.now();
  options.onProgress?.({
    phase: 'repository-update',
    status: 'start',
  });
  const repositoryUpdate = root
    ? await updateRepositories({
        dryRun,
        generatedAt,
        onProgress: (event: RepositoryUpdateProgressEvent) => {
          options.onProgress?.({
            current: event.current,
            ...(event.repository ? { detail: event.repository } : {}),
            phase: 'repository-update',
            status: event.status,
            total: event.total,
          });
        },
        root,
        ...(options.runGitOutputCommand ? { runner: options.runGitOutputCommand } : {}),
      })
    : emptyRepositoryUpdateReport({ dryRun, generatedAt, root: outputDir });
  if (!root) {
    options.onProgress?.({
      current: 0,
      phase: 'repository-update',
      status: 'done',
      total: 0,
    });
  }
  timings.repositoryUpdateMs = elapsedMs(repositoryUpdateStart);
  const manifestScanStart = performance.now();
  options.onProgress?.({
    phase: 'manifest-scan',
    status: 'start',
  });
  const parsedManifest = root
    ? await readManifestRequirements(root, {
        includeDev,
        includePeer,
        skipManifestsCoveredByLockfiles: true,
      })
    : { gitRequirements: [], requirements: [], unsupported: [] };
  options.onProgress?.({
    current: parsedManifest.requirements.length + parsedManifest.gitRequirements.length,
    phase: 'manifest-scan',
    status: 'done',
  });
  timings.manifestScanMs = elapsedMs(manifestScanStart);
  const lockfileScanStart = performance.now();
  options.onProgress?.({
    phase: 'lockfile-scan',
    status: 'start',
  });
  const parsedLockfiles = root
    ? await readLockfileRequirements(root)
    : { gitRequirements: [], requirements: [], unsupported: [] };
  options.onProgress?.({
    current: parsedLockfiles.requirements.length + parsedLockfiles.gitRequirements.length,
    phase: 'lockfile-scan',
    status: 'done',
  });
  timings.lockfileScanMs = elapsedMs(lockfileScanStart);
  const state: RequirementState = {
    gitRequirements: [],
    requirements: [],
    unsupported: [],
  };
  const seenRequirements = new Set<string>();
  const seenGitRequirements = new Set<string>();
  const seenUnsupported = new Set<string>();
  const scannedSourceIds = new Set<string>();
  const scanErrors: CollectGitManifestScanError[] = [];
  const iterations: CollectIterationReport[] = [];

  addUnique(state.requirements, seenRequirements, parsedManifest.requirements, requirementKey);
  addUnique(state.requirements, seenRequirements, parsedLockfiles.requirements, requirementKey);
  addUnique(
    state.requirements,
    seenRequirements,
    options.initialRequirements ?? [],
    requirementKey
  );
  addUnique(
    state.gitRequirements,
    seenGitRequirements,
    parsedManifest.gitRequirements,
    gitRequirementKey
  );
  addUnique(
    state.gitRequirements,
    seenGitRequirements,
    parsedLockfiles.gitRequirements,
    gitRequirementKey
  );
  addUnique(
    state.gitRequirements,
    seenGitRequirements,
    options.initialGitRequirements ?? [],
    gitRequirementKey
  );
  addUnique(state.unsupported, seenUnsupported, parsedManifest.unsupported, unsupportedKey);
  addUnique(state.unsupported, seenUnsupported, options.initialUnsupported ?? [], unsupportedKey);

  let resolution: FetchSeedBundleResult | undefined;
  let fetch = createFetchReport({
    downloaded: 0,
    errors: [],
    generatedAt,
    gitRequirements: [],
    resolved: 0,
    skipped: 0,
    unsupported: [],
  });
  let gitSources = createGitSourcesManifest([], {
    createdAt: generatedAt,
    initialSources: options.initialGitSources ?? [],
  });
  let gitFetch = emptyGitFetchReport({
    dryRun,
    generatedAt,
    mirrorsDir: path.join(outputDir, 'git-mirrors'),
  });
  let maxIterationsReached = false;
  const fetchReports: FetchReport[] = [];
  const gitFetchReports: GitFetchReport[] = [];
  let lastFetchedGitSourcesKey: string | undefined;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const iterationStart = performance.now();
    const fetchIterationStart = performance.now();
    options.onProgress?.({
      detail: `${String(state.requirements.length)} npm requirements`,
      iteration,
      phase: 'npm-fetch',
      status: 'start',
    });
    resolution = await fetchSeedBundle({
      download: !dryRun,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      includePeer,
      latestPolicy: options.latestPolicy ?? 'bundled',
      rangeResolutionPolicy: options.rangeResolutionPolicy ?? 'reuse-stable',
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      onProgress: (event: FetchProgressEvent) => {
        const detail = [event.phase, event.package].filter(Boolean).join(' ');
        options.onProgress?.({
          ...(event.current === undefined ? {} : { current: event.current }),
          ...(detail ? { detail } : {}),
          iteration,
          phase: 'npm-fetch',
          ...(event.queue === undefined ? {} : { queue: event.queue }),
          status: event.status,
        });
      },
      outputDir,
      registry: options.registry,
      metadataCache,
      stableRequiredBy,
      stableTagResolutions,
      tagResolutionPolicy,
      ...(options.tarballTimeoutMs ? { tarballTimeoutMs: options.tarballTimeoutMs } : {}),
      gitRequirements: state.gitRequirements,
      requirements: state.requirements,
      unsupported: state.unsupported,
    });
    const fetchMs = elapsedMs(fetchIterationStart);
    timings.fetchIterationsMs += fetchMs;
    fetch = createFetchReport({
      downloaded: resolution.downloaded,
      downloadedPackages: resolution.downloadedPackages,
      errors: resolution.errors,
      generatedAt,
      gitRequirements: resolution.gitRequirements,
      resolved: resolution.resolved.length,
      skipped: resolution.skipped,
      timings: resolution.timings,
      unsupported: resolution.unsupported,
      wouldDownloadPackages: resolution.wouldDownloadPackages,
    });
    fetchReports.push(fetch);
    gitSources = createGitSourcesManifest(resolution.gitRequirements, {
      createdAt: generatedAt,
      initialSources: options.initialGitSources ?? [],
    });
    const gitSourcesKey = gitSourcesFetchKey(gitSources.sources);
    const gitFetchStart = performance.now();
    const shouldFetchGitSources = gitSourcesKey !== lastFetchedGitSourcesKey;
    if (shouldFetchGitSources) {
      gitFetch = await fetchGitSources({
        bundleDir: outputDir,
        dryRun,
        generatedAt,
        manifest: gitSources,
        onProgress: (event: GitFetchProgressEvent) => {
          const detail = formatGitFetchProgressDetail(event);
          options.onProgress?.({
            current: event.current,
            ...(detail ? { detail } : {}),
            iteration,
            phase: 'git-fetch',
            status: event.status,
            total: event.total,
          });
        },
        ...(options.runGitCommand ? { runner: options.runGitCommand } : {}),
      });
      if (gitFetch.errors.length === 0) {
        lastFetchedGitSourcesKey = gitSourcesKey;
      }
      gitFetchReports.push(gitFetch);
    }
    const gitFetchMs = elapsedMs(gitFetchStart);
    timings.gitFetchMs += gitFetchMs;
    addUnique(
      state.gitRequirements,
      seenGitRequirements,
      resolution.gitRequirements,
      gitRequirementKey
    );
    addUnique(state.unsupported, seenUnsupported, resolution.unsupported, unsupportedKey);

    const beforeRequirementCount = state.requirements.length;
    const beforeGitRequirementCount = state.gitRequirements.length;
    const beforeUnsupportedCount = state.unsupported.length;
    let scannedGitSources = 0;
    let gitManifestScanMs = 0;

    if (
      shouldFetchGitSources &&
      !dryRun &&
      resolution.errors.length === 0 &&
      gitFetch.errors.length === 0
    ) {
      const gitManifestScanStart = performance.now();
      options.onProgress?.({
        current: 0,
        iteration,
        phase: 'git-manifest-scan',
        status: 'start',
        total: gitSources.sources.length,
      });
      const scan = await scanGitSourceManifests({
        bundleDir: outputDir,
        includeDev,
        includePeer,
        ...(options.runGitOutputCommand
          ? { runGitOutputCommand: options.runGitOutputCommand }
          : {}),
        scannedSourceIds,
        sources: gitSources.sources,
        unchangedSourceIds: new Set(
          gitFetch.actions
            .filter((action) => action.changed === false)
            .map((action) => action.repository)
        ),
      });
      scannedGitSources = scan.scanned;
      for (const requiredBy of scan.stableRequiredBy) {
        stableRequiredBy.add(requiredBy);
      }
      scanErrors.push(...scan.errors);
      addUnique(state.requirements, seenRequirements, scan.state.requirements, requirementKey);
      addUnique(
        state.gitRequirements,
        seenGitRequirements,
        scan.state.gitRequirements,
        gitRequirementKey
      );
      addUnique(state.unsupported, seenUnsupported, scan.state.unsupported, unsupportedKey);
      gitManifestScanMs = elapsedMs(gitManifestScanStart);
      timings.gitManifestScanMs += gitManifestScanMs;
      options.onProgress?.({
        current: scannedGitSources,
        iteration,
        phase: 'git-manifest-scan',
        status: scan.errors.length > 0 ? 'error' : 'done',
        total: gitSources.sources.length,
      });
    }

    const addedRequirements = state.requirements.length - beforeRequirementCount;
    const addedGitRequirements = state.gitRequirements.length - beforeGitRequirementCount;
    const addedUnsupported = state.unsupported.length - beforeUnsupportedCount;
    iterations.push({
      addedGitRequirements,
      addedRequirements,
      addedUnsupported,
      downloaded: resolution.downloaded,
      errors: resolution.errors.length,
      fetchMs,
      gitFetchMs,
      gitManifestScanMs,
      gitSources: sourceIds(gitSources.sources).size,
      iteration,
      resolved: resolution.resolved.length,
      scannedGitSources,
      skipped: resolution.skipped,
      totalMs: elapsedMs(iterationStart),
    });

    if (
      dryRun ||
      scanErrors.length > 0 ||
      (addedRequirements === 0 && addedGitRequirements === 0 && addedUnsupported === 0)
    ) {
      break;
    }

    if (iteration === maxIterations) {
      maxIterationsReached = true;
    }
  }

  const fixedPoint =
    !dryRun &&
    !maxIterationsReached &&
    scanErrors.length === 0 &&
    iterations.at(-1)?.addedRequirements === 0 &&
    iterations.at(-1)?.addedGitRequirements === 0 &&
    iterations.at(-1)?.addedUnsupported === 0;
  const reportGitFetch = aggregateGitFetchReports(gitFetchReports) ?? gitFetch;
  const reportFetch = aggregateFetchReports(fetchReports) ?? fetch;
  const wroteBundle =
    !dryRun &&
    reportFetch.errors.length === 0 &&
    reportGitFetch.errors.length === 0 &&
    scanErrors.length === 0 &&
    !maxIterationsReached;

  timings.totalMs = elapsedMs(totalStart);
  const report: CollectReport = {
    dryRun,
    fetch: reportFetch,
    fixedPoint,
    generatedAt,
    gitFetch: reportGitFetch,
    gitManifestScanErrors: scanErrors,
    gitSources,
    iterations,
    maxIterationsReached,
    outputDir,
    registryUrl: options.registryUrl,
    repositoryUpdate,
    root: root ?? outputDir,
    timings,
    wroteBundle,
  };

  if (!dryRun) {
    if (wroteBundle && resolution) {
      const bundleDocumentsStart = performance.now();
      options.onProgress?.({
        phase: 'bundle-write',
        status: 'start',
      });
      const documents = createBundleDocuments({
        outputDir,
        resolved: resolution.resolved,
        sourceRegistry: options.registryUrl,
        latestPolicy: options.latestPolicy ?? 'bundled',
        tagRequirements: resolution.tagRequirements,
      });
      await writeBundleDocuments(outputDir, documents);
      timings.bundleDocumentsMs = elapsedMs(bundleDocumentsStart);
      options.onProgress?.({
        current: documents.manifest.packages.length,
        phase: 'bundle-write',
        status: 'done',
      });
    }

    if (wroteBundle || (reportFetch.timings.metadataCacheMemoryWrites ?? 0) > 0) {
      await writeRegistryMetadataCache(outputDir, metadataCache, {
        createdAt: generatedAt,
        sourceRegistry: options.registryUrl,
      });
      reportFetch.timings.metadataCachePersisted = true;
    }

    const reportWriteStart = performance.now();
    await writeFetchReport(outputDir, reportFetch);
    await writeGitSourcesManifest(outputDir, gitSources);
    await writeGitFetchReport(outputDir, reportGitFetch);
    timings.reportWriteMs = elapsedMs(reportWriteStart);
    timings.totalMs = elapsedMs(totalStart);
    await writeCollectReport(outputDir, report);
  }

  return report;
}
