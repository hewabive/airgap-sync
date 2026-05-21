import path from 'node:path';
import fs from 'fs-extra';
import type {
  CollectGitManifestScanError,
  CollectIterationReport,
  CollectReport,
  GitRequirement,
  GitSource,
  RootPackageRequirement,
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
import { fetchGitSources, type GitCommandRunner } from './git-fetch.js';
import { readGitSourceManifestRequirements } from './git-manifests.js';
import { createGitSourcesManifest, writeGitSourcesManifest } from './git-sources.js';
import { gitSourceMirrorPath } from './git-targets.js';
import { readLockfileRequirements } from './lockfiles.js';
import { readManifestRequirements } from './manifests.js';
import type { RegistryClient } from './registry.js';
import { type GitOutputCommandRunner, updateRepositories } from './repos.js';

export interface CollectBundleOptions {
  dryRun?: boolean;
  generatedAt?: string;
  includeDev?: boolean;
  includePeer?: boolean;
  maxIterations?: number;
  outputDir: string;
  registry: RegistryClient;
  registryUrl: string;
  root: string;
  runGitCommand?: GitCommandRunner;
  runGitOutputCommand?: GitOutputCommandRunner;
}

interface RequirementState {
  gitRequirements: GitRequirement[];
  requirements: RootPackageRequirement[];
  unsupported: UnsupportedRootPackageRequirement[];
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

async function scanGitSourceManifests(options: {
  bundleDir: string;
  includeDev: boolean;
  includePeer: boolean;
  runGitOutputCommand?: GitOutputCommandRunner;
  scannedSourceIds: Set<string>;
  sources: GitSource[];
}): Promise<{
  errors: CollectGitManifestScanError[];
  scanned: number;
  state: RequirementState;
}> {
  const errors: CollectGitManifestScanError[] = [];
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

  return { errors, scanned, state };
}

export async function collectBundle(options: CollectBundleOptions): Promise<CollectReport> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const root = path.resolve(options.root);
  const outputDir = path.resolve(options.outputDir);
  const dryRun = options.dryRun === true;
  const includeDev = options.includeDev === true;
  const includePeer = options.includePeer === true;
  const maxIterations = options.maxIterations ?? 10;

  const repositoryUpdate = await updateRepositories({
    dryRun,
    generatedAt,
    root,
    ...(options.runGitOutputCommand ? { runner: options.runGitOutputCommand } : {}),
  });
  const parsedManifest = await readManifestRequirements(root, {
    includeDev,
    includePeer,
  });
  const parsedLockfiles = await readLockfileRequirements(root);
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
  addUnique(state.unsupported, seenUnsupported, parsedManifest.unsupported, unsupportedKey);

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
  let gitSources = createGitSourcesManifest([], { createdAt: generatedAt });
  let gitFetch = await fetchGitSources({
    bundleDir: outputDir,
    dryRun: true,
    generatedAt,
    manifest: gitSources,
    ...(options.runGitCommand ? { runner: options.runGitCommand } : {}),
  });
  let maxIterationsReached = false;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    resolution = await fetchSeedBundle({
      download: !dryRun,
      includePeer,
      outputDir,
      registry: options.registry,
      gitRequirements: state.gitRequirements,
      requirements: state.requirements,
      unsupported: state.unsupported,
    });
    fetch = createFetchReport({
      downloaded: resolution.downloaded,
      errors: resolution.errors,
      generatedAt,
      gitRequirements: resolution.gitRequirements,
      resolved: resolution.resolved.length,
      skipped: resolution.skipped,
      unsupported: resolution.unsupported,
    });
    gitSources = createGitSourcesManifest(resolution.gitRequirements, {
      createdAt: generatedAt,
    });
    gitFetch = await fetchGitSources({
      bundleDir: outputDir,
      dryRun,
      generatedAt,
      manifest: gitSources,
      ...(options.runGitCommand ? { runner: options.runGitCommand } : {}),
    });
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

    if (!dryRun && resolution.errors.length === 0 && gitFetch.errors.length === 0) {
      const scan = await scanGitSourceManifests({
        bundleDir: outputDir,
        includeDev,
        includePeer,
        ...(options.runGitOutputCommand
          ? { runGitOutputCommand: options.runGitOutputCommand }
          : {}),
        scannedSourceIds,
        sources: gitSources.sources,
      });
      scannedGitSources = scan.scanned;
      scanErrors.push(...scan.errors);
      addUnique(state.requirements, seenRequirements, scan.state.requirements, requirementKey);
      addUnique(
        state.gitRequirements,
        seenGitRequirements,
        scan.state.gitRequirements,
        gitRequirementKey
      );
      addUnique(state.unsupported, seenUnsupported, scan.state.unsupported, unsupportedKey);
    }

    const addedRequirements = state.requirements.length - beforeRequirementCount;
    const addedGitRequirements = state.gitRequirements.length - beforeGitRequirementCount;
    const addedUnsupported = state.unsupported.length - beforeUnsupportedCount;
    iterations.push({
      addedGitRequirements,
      addedRequirements,
      addedUnsupported,
      gitSources: sourceIds(gitSources.sources).size,
      iteration,
      resolved: resolution.resolved.length,
      scannedGitSources,
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
  const wroteBundle =
    !dryRun &&
    resolution?.errors.length === 0 &&
    gitFetch.errors.length === 0 &&
    scanErrors.length === 0 &&
    !maxIterationsReached;

  const report: CollectReport = {
    dryRun,
    fetch,
    fixedPoint,
    generatedAt,
    gitFetch,
    gitManifestScanErrors: scanErrors,
    gitSources,
    iterations,
    maxIterationsReached,
    outputDir,
    registryUrl: options.registryUrl,
    repositoryUpdate,
    root,
    wroteBundle,
  };

  if (!dryRun) {
    await writeFetchReport(outputDir, fetch);
    await writeGitSourcesManifest(outputDir, gitSources);
    await writeGitFetchReport(outputDir, gitFetch);
    await writeCollectReport(outputDir, report);
  }

  if (wroteBundle && resolution) {
    const documents = createBundleDocuments({
      outputDir,
      resolved: resolution.resolved,
      sourceRegistry: options.registryUrl,
      tagRequirements: resolution.tagRequirements,
    });
    await writeBundleDocuments(outputDir, documents);
  }

  return report;
}
