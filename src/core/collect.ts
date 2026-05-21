import path from 'node:path';
import type { CollectReport } from '../types.js';
import {
  createBundleDocuments,
  createFetchReport,
  writeBundleDocuments,
  writeCollectReport,
  writeFetchReport,
  writeGitFetchReport,
} from './bundle.js';
import { fetchSeedBundle } from './fetcher.js';
import { fetchGitSources, type GitCommandRunner } from './git-fetch.js';
import { createGitSourcesManifest, writeGitSourcesManifest } from './git-sources.js';
import { readManifestRequirements } from './manifests.js';
import type { RegistryClient } from './registry.js';
import { type GitOutputCommandRunner, updateRepositories } from './repos.js';

export interface CollectBundleOptions {
  dryRun?: boolean;
  generatedAt?: string;
  includeDev?: boolean;
  includePeer?: boolean;
  outputDir: string;
  registry: RegistryClient;
  registryUrl: string;
  root: string;
  runGitCommand?: GitCommandRunner;
  runGitOutputCommand?: GitOutputCommandRunner;
}

export async function collectBundle(options: CollectBundleOptions): Promise<CollectReport> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const root = path.resolve(options.root);
  const outputDir = path.resolve(options.outputDir);
  const dryRun = options.dryRun === true;

  const repositoryUpdate = await updateRepositories({
    dryRun,
    generatedAt,
    root,
    ...(options.runGitOutputCommand ? { runner: options.runGitOutputCommand } : {}),
  });
  const parsedManifest = await readManifestRequirements(root, {
    includeDev: options.includeDev === true,
    includePeer: options.includePeer === true,
  });
  const resolution = await fetchSeedBundle({
    download: !dryRun,
    includePeer: options.includePeer === true,
    outputDir,
    registry: options.registry,
    gitRequirements: parsedManifest.gitRequirements,
    requirements: parsedManifest.requirements,
    unsupported: parsedManifest.unsupported,
  });
  const fetch = createFetchReport({
    downloaded: resolution.downloaded,
    errors: resolution.errors,
    generatedAt,
    gitRequirements: resolution.gitRequirements,
    resolved: resolution.resolved.length,
    skipped: resolution.skipped,
    unsupported: resolution.unsupported,
  });
  const gitSources = createGitSourcesManifest(resolution.gitRequirements, {
    createdAt: generatedAt,
  });
  const gitFetch = await fetchGitSources({
    bundleDir: outputDir,
    dryRun,
    generatedAt,
    manifest: gitSources,
    ...(options.runGitCommand ? { runner: options.runGitCommand } : {}),
  });
  const wroteBundle = !dryRun && resolution.errors.length === 0;

  const report: CollectReport = {
    dryRun,
    fetch,
    generatedAt,
    gitFetch,
    gitSources,
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

  if (wroteBundle) {
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
