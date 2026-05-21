import path from 'node:path';
import * as fs from './fs.js';
import {
  readBundleManifest,
  readDistTagsManifest,
  writeApplyReport,
  writeGitApplyReport,
  writeGitConfigReport,
  writeGiteaRepositoryProvisionReport,
  writePublishReport,
} from './bundle.js';
import { applyGitSources } from './git-apply.js';
import { configureGitRewrites } from './git-config.js';
import { type GitCommandRunner } from './git-fetch.js';
import { provisionGiteaRepositories, type GiteaClient } from './gitea.js';
import { publishBundle, type PublishBundleOptions } from './publisher.js';
import type {
  ApplyBundleReport,
  GiteaRepositoryProvisionReport,
  GitApplyReport,
  GitConfigReport,
  GitSourcesManifest,
  PublishReport,
} from '../types.js';

export interface ApplyBundleOptions {
  bundleDir: string;
  configureGitGlobal?: boolean;
  dryRun?: boolean;
  generatedAt?: string;
  giteaBaseUrl: string;
  giteaClient: GiteaClient;
  mirrorsDir?: string;
  onPublishProgress?: PublishBundleOptions['onProgress'];
  private?: boolean;
  registryUrl: string;
  runGitCommand?: GitCommandRunner;
  skipExisting?: boolean;
}

function emptyGitSourcesManifest(generatedAt: string): GitSourcesManifest {
  return {
    schemaVersion: 1,
    createdAt: generatedAt,
    sources: [],
    skipped: [],
  };
}

async function readOptionalGitSourcesManifest(
  bundleDir: string,
  generatedAt: string
): Promise<GitSourcesManifest> {
  const filePath = path.join(bundleDir, 'git-sources.json');
  if (!(await fs.pathExists(filePath))) {
    return emptyGitSourcesManifest(generatedAt);
  }

  return fs.readJson<GitSourcesManifest>(filePath);
}

function applySucceeded(reports: {
  gitApply: GitApplyReport;
  gitConfig?: GitConfigReport;
  gitea: GiteaRepositoryProvisionReport;
  publish: PublishReport;
}): boolean {
  return (
    reports.publish.errors.length === 0 &&
    reports.gitea.errors.length === 0 &&
    reports.gitea.organizationErrors.length === 0 &&
    reports.gitApply.errors.length === 0 &&
    (reports.gitConfig?.errors.length ?? 0) === 0
  );
}

export async function applyBundle(options: ApplyBundleOptions): Promise<ApplyBundleReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const dryRun = options.dryRun === true;
  const manifest = await readBundleManifest(bundleDir);
  const distTags = await readDistTagsManifest(bundleDir);
  const gitSources = await readOptionalGitSourcesManifest(bundleDir, generatedAt);

  const publish = await publishBundle(manifest, distTags, {
    bundleDir,
    dryRun,
    registryUrl: options.registryUrl,
    ...(options.onPublishProgress ? { onProgress: options.onPublishProgress } : {}),
    ...(options.skipExisting === undefined ? {} : { skipExisting: options.skipExisting }),
  });
  await writePublishReport(bundleDir, publish);

  const gitea = await provisionGiteaRepositories({
    client: options.giteaClient,
    dryRun,
    generatedAt,
    giteaBaseUrl: options.giteaBaseUrl,
    manifest: gitSources,
    private: options.private ?? true,
  });
  await writeGiteaRepositoryProvisionReport(bundleDir, gitea);

  const gitApply = await applyGitSources({
    bundleDir,
    dryRun,
    generatedAt,
    giteaBaseUrl: options.giteaBaseUrl,
    manifest: gitSources,
    ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
    ...(options.runGitCommand ? { runner: options.runGitCommand } : {}),
  });
  await writeGitApplyReport(bundleDir, gitApply);

  const gitConfig = options.configureGitGlobal
    ? await configureGitRewrites({
        dryRun,
        generatedAt,
        giteaBaseUrl: options.giteaBaseUrl,
        manifest: gitSources,
        ...(options.runGitCommand ? { runner: options.runGitCommand } : {}),
      })
    : undefined;
  if (gitConfig) {
    await writeGitConfigReport(bundleDir, gitConfig);
  }

  const report: ApplyBundleReport = {
    dryRun,
    generatedAt,
    gitApply,
    ...(gitConfig ? { gitConfig } : {}),
    gitea,
    publish,
    registryUrl: options.registryUrl,
    succeeded: applySucceeded({ gitApply, ...(gitConfig ? { gitConfig } : {}), gitea, publish }),
  };
  await writeApplyReport(bundleDir, report);

  return report;
}
