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
import { applyGitSources, type GitHttpAuth } from './git-apply.js';
import { configureGitRewrites } from './git-config.js';
import { type GitCommandRunner } from './git-fetch.js';
import {
  assumeGiteaRepositoriesExist,
  provisionGiteaRepositories,
  type GiteaClient,
} from './gitea.js';
import { publishBundle, type PublishBundleOptions } from './publisher.js';
import { readPythonSeedManifest, writePythonPublishReport } from './python/bundle.js';
import {
  publishPythonBundle,
  type PythonPublishAuth,
  type PythonPublishReport,
} from './python/publisher.js';
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
  distTagConcurrency?: number;
  dryRun?: boolean;
  generatedAt?: string;
  gitAuth?: GitHttpAuth;
  giteaBaseUrl: string;
  giteaClient: GiteaClient;
  mirrorsDir?: string;
  onProgress?: (event: ApplyProgressEvent) => void;
  onPublishProgress?: PublishBundleOptions['onProgress'];
  private?: boolean;
  pythonAuth?: PythonPublishAuth;
  pythonOwner?: string;
  publishConcurrency?: number;
  registryUrl: string;
  runGitCommand?: GitCommandRunner;
  skipExisting?: boolean;
  skipGitProvision?: boolean;
}

export type ApplyProgressPhase =
  | 'publish'
  | 'python-publish'
  | 'gitea'
  | 'git-apply'
  | 'git-config'
  | 'report';

export type ApplyProgressStatus = 'start' | 'done';

export interface ApplyProgressEvent {
  phase: ApplyProgressPhase;
  status: ApplyProgressStatus;
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
  python?: PythonPublishReport;
}): boolean {
  return (
    reports.publish.errors.length === 0 &&
    (reports.python?.errors.length ?? 0) === 0 &&
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
  const pythonManifest = (await fs.pathExists(path.join(bundleDir, 'python-seed-manifest.json')))
    ? await readPythonSeedManifest(bundleDir)
    : undefined;

  options.onProgress?.({ phase: 'publish', status: 'start' });
  const publish = await publishBundle(manifest, distTags, {
    bundleDir,
    ...(options.distTagConcurrency === undefined
      ? {}
      : { distTagConcurrency: options.distTagConcurrency }),
    dryRun,
    ...(options.publishConcurrency === undefined
      ? {}
      : { publishConcurrency: options.publishConcurrency }),
    registryUrl: options.registryUrl,
    ...(options.onPublishProgress ? { onProgress: options.onPublishProgress } : {}),
    ...(options.skipExisting === undefined ? {} : { skipExisting: options.skipExisting }),
  });
  await writePublishReport(bundleDir, publish);
  options.onProgress?.({ phase: 'publish', status: 'done' });

  let python: PythonPublishReport | undefined;
  if (pythonManifest) {
    if (!options.pythonOwner) {
      throw new Error('Python bundle publishing requires pythonPublishOwner or --python-owner');
    }
    options.onProgress?.({ phase: 'python-publish', status: 'start' });
    python = await publishPythonBundle(pythonManifest, {
      ...(options.pythonAuth ? { auth: options.pythonAuth } : {}),
      bundleDir,
      dryRun,
      generatedAt,
      giteaBaseUrl: options.giteaBaseUrl,
      owner: options.pythonOwner,
      ...(options.publishConcurrency === undefined
        ? {}
        : { concurrency: options.publishConcurrency }),
    });
    await writePythonPublishReport(bundleDir, python);
    options.onProgress?.({ phase: 'python-publish', status: 'done' });
  }

  options.onProgress?.({ phase: 'gitea', status: 'start' });
  const gitea =
    options.skipGitProvision === true && !dryRun
      ? assumeGiteaRepositoriesExist({
          generatedAt,
          giteaBaseUrl: options.giteaBaseUrl,
          manifest: gitSources,
          private: options.private ?? true,
        })
      : await provisionGiteaRepositories({
          client: options.giteaClient,
          dryRun,
          generatedAt,
          giteaBaseUrl: options.giteaBaseUrl,
          manifest: gitSources,
          private: options.private ?? true,
        });
  await writeGiteaRepositoryProvisionReport(bundleDir, gitea);
  options.onProgress?.({ phase: 'gitea', status: 'done' });

  options.onProgress?.({ phase: 'git-apply', status: 'start' });
  const gitApply = await applyGitSources({
    bundleDir,
    dryRun,
    generatedAt,
    ...(options.gitAuth ? { gitAuth: options.gitAuth } : {}),
    giteaBaseUrl: options.giteaBaseUrl,
    manifest: gitSources,
    ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
    ...(options.runGitCommand ? { runner: options.runGitCommand } : {}),
  });
  await writeGitApplyReport(bundleDir, gitApply);
  options.onProgress?.({ phase: 'git-apply', status: 'done' });

  const gitConfig = options.configureGitGlobal
    ? await (async () => {
        options.onProgress?.({ phase: 'git-config', status: 'start' });
        const report = await configureGitRewrites({
          dryRun,
          generatedAt,
          giteaBaseUrl: options.giteaBaseUrl,
          manifest: gitSources,
          ...(options.runGitCommand ? { runner: options.runGitCommand } : {}),
        });
        options.onProgress?.({ phase: 'git-config', status: 'done' });
        return report;
      })()
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
    ...(python ? { python } : {}),
    registryUrl: options.registryUrl,
    succeeded: applySucceeded({
      gitApply,
      ...(gitConfig ? { gitConfig } : {}),
      gitea,
      publish,
      ...(python ? { python } : {}),
    }),
  };
  options.onProgress?.({ phase: 'report', status: 'start' });
  await writeApplyReport(bundleDir, report);
  options.onProgress?.({ phase: 'report', status: 'done' });

  return report;
}
