import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as fs from './fs.js';
import type {
  GitApplyActionResult,
  GitApplyReport,
  GitConfigRewriteRule,
  GitSource,
  GitSourcesManifest,
} from '../types.js';
import type { GiteaClient } from './gitea.js';
import { runGitCommand, type GitCommandRunner } from './git-fetch.js';
import { safeDirectoryGitArgs } from './git-safe.js';
import {
  gitSourceMirrorPath,
  gitSourcePublishOwner,
  gitSourcePublishRepo,
  gitSourceTargetUrl,
  normalizeBaseUrl,
} from './git-targets.js';
import { assertUniqueGitPublishTargets } from './git-publish-targets.js';
import { mapConcurrent } from './concurrency.js';

export interface ApplyGitSourcesOptions {
  bundleDir: string;
  concurrency?: number;
  dryRun?: boolean;
  giteaBaseUrl: string;
  generatedAt?: string;
  gitAuth?: GitHttpAuth;
  giteaClient?: Pick<GiteaClient, 'getRepositoryState' | 'setRepositoryDefaultBranch'>;
  manifest: GitSourcesManifest;
  mirrorsDir?: string;
  onProgress?: (event: GitApplyProgressEvent) => void;
  runner?: GitCommandRunner;
}

export interface GitHttpAuth {
  password: string;
  username: string;
}

export type GitApplyProgressStatus = 'start' | 'progress' | 'done';

export interface GitApplyProgressEvent {
  action?: GitApplyActionResult;
  current: number;
  repository?: string;
  status: GitApplyProgressStatus;
  total: number;
}

function quoteGitConfigPart(value: string): string {
  return JSON.stringify(value);
}

export function createGitConfigRewriteRules(
  manifest: GitSourcesManifest,
  giteaBaseUrl: string
): GitConfigRewriteRule[] {
  assertUniqueGitPublishTargets(manifest);
  const seen = new Set<string>();
  const rules: GitConfigRewriteRule[] = [];

  for (const source of manifest.sources) {
    if (
      (source.publishOwner ?? source.owner) === source.owner &&
      (source.publishRepo ?? source.repo) === source.repo
    ) {
      const targetUrl = `${normalizeBaseUrl(giteaBaseUrl)}/`;
      for (const insteadOf of [
        `git@${source.host}:`,
        `https://${source.host}/`,
        `ssh://git@${source.host}/`,
      ]) {
        const key = `${targetUrl}\0${insteadOf}`;
        if (!seen.has(key)) {
          seen.add(key);
          rules.push({
            command: `git config --global --add url.${quoteGitConfigPart(targetUrl)}.insteadOf ${quoteGitConfigPart(insteadOf)}`,
            insteadOf,
            targetUrl,
          });
        }
      }
      continue;
    }

    const targetWithSuffix = gitSourceTargetUrl(source, giteaBaseUrl);
    const targetWithoutSuffix = targetWithSuffix.replace(/\.git$/, '');
    for (const sourcePrefix of [
      `git@${source.host}:${source.owner}/${source.repo}`,
      `https://${source.host}/${source.owner}/${source.repo}`,
      `ssh://git@${source.host}/${source.owner}/${source.repo}`,
    ]) {
      for (const [targetUrl, insteadOf] of [
        [targetWithSuffix, `${sourcePrefix}.git`],
        [targetWithoutSuffix, sourcePrefix],
      ] as [string, string][]) {
        const key = `${targetUrl}\0${insteadOf}`;
        if (!seen.has(key)) {
          seen.add(key);
          rules.push({
            command: `git config --global --add url.${quoteGitConfigPart(targetUrl)}.insteadOf ${quoteGitConfigPart(insteadOf)}`,
            insteadOf,
            targetUrl,
          });
        }
      }
    }
  }

  return rules.sort(
    (left, right) =>
      left.insteadOf.localeCompare(right.insteadOf) || left.targetUrl.localeCompare(right.targetUrl)
  );
}

function sourcePath(source: GitSource, options: ApplyGitSourcesOptions): string {
  return gitSourceMirrorPath({
    bundleDir: options.bundleDir,
    ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
    source,
  });
}

function gitHttpAuthHeader(auth: GitHttpAuth): string {
  return `Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString(
    'base64'
  )}`;
}

const giteaMirrorRefspecs = ['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'];
const repositoryReadyPollMs = 100;
const repositoryReadyTimeoutMs = 30_000;
const maxErrorLines = 80;
const maxErrorChars = 12_000;

function pushArgs(mirrorPath: string, targetUrl: string, auth?: GitHttpAuth): string[] {
  return safeDirectoryGitArgs(mirrorPath, [
    ...(auth
      ? ['-c', 'credential.helper=', '-c', `http.extraHeader=${gitHttpAuthHeader(auth)}`]
      : []),
    '-C',
    mirrorPath,
    'push',
    '--prune',
    targetUrl,
    ...giteaMirrorRefspecs,
  ]);
}

function pushDefaultBranchArgs(
  mirrorPath: string,
  targetUrl: string,
  branch: string,
  auth?: GitHttpAuth
): string[] {
  return safeDirectoryGitArgs(mirrorPath, [
    ...(auth
      ? ['-c', 'credential.helper=', '-c', `http.extraHeader=${gitHttpAuthHeader(auth)}`]
      : []),
    '-C',
    mirrorPath,
    'push',
    targetUrl,
    `+refs/heads/${branch}:refs/heads/${branch}`,
  ]);
}

function pushEnv(): NodeJS.ProcessEnv {
  return {
    GCM_INTERACTIVE: 'never',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function mirrorDefaultBranch(mirrorPath: string, runner: GitCommandRunner): Promise<string> {
  const result = await runner({
    args: safeDirectoryGitArgs(mirrorPath, [
      '-C',
      mirrorPath,
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]),
  });
  const branch = result?.stdout.trim();
  if (!branch) {
    throw new Error(`mirror HEAD does not name a branch: ${mirrorPath}`);
  }
  return branch;
}

async function waitForRepositoryReady(
  client: NonNullable<ApplyGitSourcesOptions['giteaClient']>,
  repository: { name: string; owner: string }
): Promise<void> {
  const getRepositoryState = client.getRepositoryState;
  if (!getRepositoryState) return;
  const deadline = Date.now() + repositoryReadyTimeoutMs;

  for (;;) {
    const state = await getRepositoryState.call(client, repository);
    if (!state.empty) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Gitea still reports ${repository.owner}/${repository.name} as empty after the default branch push`
      );
    }
    await delay(repositoryReadyPollMs);
  }
}

function summarizeErrorMessage(message: string): string {
  const lines = message.trim().split(/\r?\n/);
  const summarizedLines =
    lines.length > maxErrorLines
      ? [
          ...lines.slice(0, maxErrorLines / 2),
          `[airgap-sync] truncated ${String(lines.length - maxErrorLines)} git output lines`,
          ...lines.slice(lines.length - maxErrorLines / 2),
        ]
      : lines;
  const summarized = summarizedLines.join('\n');

  if (summarized.length <= maxErrorChars) {
    return summarized;
  }

  return `${summarized.slice(0, maxErrorChars)}\n[airgap-sync] truncated git error output`;
}

async function applyRepository(
  source: GitSource,
  options: ApplyGitSourcesOptions,
  runner: GitCommandRunner
): Promise<GitApplyActionResult> {
  const mirrorPath = sourcePath(source, options);
  const targetUrl = gitSourceTargetUrl(source, options.giteaBaseUrl);
  const getRepositoryState = options.giteaClient?.getRepositoryState;
  const setRepositoryDefaultBranch = options.giteaClient?.setRepositoryDefaultBranch;
  let defaultBranch: string | undefined;

  if (!(await fs.pathExists(mirrorPath))) {
    return {
      repository: source.id,
      sourcePath: mirrorPath,
      status: 'missing-mirror',
      targetUrl,
    };
  }

  try {
    if (setRepositoryDefaultBranch) {
      defaultBranch = await mirrorDefaultBranch(mirrorPath, runner);
    }
    const repository = {
      name: gitSourcePublishRepo(source),
      owner: gitSourcePublishOwner(source),
    };
    if (getRepositoryState && defaultBranch && options.giteaClient) {
      const initialState = await getRepositoryState.call(options.giteaClient, repository);
      if (initialState.empty) {
        await runner({
          args: pushDefaultBranchArgs(mirrorPath, targetUrl, defaultBranch, options.gitAuth),
          ...(options.gitAuth ? { env: pushEnv() } : {}),
        });
        await waitForRepositoryReady(options.giteaClient, repository);
      }
    }
    await runner({
      args: pushArgs(mirrorPath, targetUrl, options.gitAuth),
      ...(options.gitAuth ? { env: pushEnv() } : {}),
    });
    if (setRepositoryDefaultBranch && defaultBranch) {
      try {
        await setRepositoryDefaultBranch.call(options.giteaClient, {
          branch: defaultBranch,
          ...repository,
        });
      } catch (error) {
        throw new Error(
          `pushed refs but failed to set Gitea default branch to ${defaultBranch}: ${(error as Error).message}`
        );
      }
    }
    if (getRepositoryState && defaultBranch && options.giteaClient) {
      const finalState = await getRepositoryState.call(options.giteaClient, repository);
      if (finalState.empty) {
        throw new Error(
          `pushed refs but Gitea still reports ${repository.owner}/${repository.name} as empty`
        );
      }
      if (finalState.defaultBranch !== defaultBranch) {
        throw new Error(
          `pushed refs but Gitea reports default branch ${JSON.stringify(
            finalState.defaultBranch
          )} instead of ${JSON.stringify(defaultBranch)}`
        );
      }
    }
    return {
      ...(defaultBranch ? { defaultBranch } : {}),
      repository: source.id,
      sourcePath: mirrorPath,
      status: 'pushed',
      targetUrl,
    };
  } catch (error) {
    return {
      ...(defaultBranch ? { defaultBranch } : {}),
      error: summarizeErrorMessage((error as Error).message),
      repository: source.id,
      sourcePath: mirrorPath,
      status: 'error',
      targetUrl,
    };
  }
}

export async function applyGitSources(options: ApplyGitSourcesOptions): Promise<GitApplyReport> {
  assertUniqueGitPublishTargets(options.manifest);
  const mirrorsDir = path.resolve(
    options.mirrorsDir ?? path.join(options.bundleDir, 'git-mirrors')
  );
  const actions: GitApplyActionResult[] = [];
  const total = options.manifest.sources.length;
  options.onProgress?.({
    current: 0,
    status: 'start',
    total,
  });

  if (options.dryRun === true) {
    for (const [index, source] of options.manifest.sources.entries()) {
      const action: GitApplyActionResult = {
        repository: source.id,
        sourcePath: sourcePath(source, options),
        status: 'planned',
        targetUrl: gitSourceTargetUrl(source, options.giteaBaseUrl),
      };
      actions.push(action);
      options.onProgress?.({
        action,
        current: index + 1,
        repository: source.id,
        status: 'progress',
        total,
      });
    }
  } else {
    const runner = options.runner ?? runGitCommand;
    let completed = 0;
    actions.push(
      ...(await mapConcurrent(
        options.manifest.sources,
        options.concurrency ?? 1,
        async (source) => {
          options.onProgress?.({
            current: completed,
            repository: source.id,
            status: 'progress',
            total,
          });
          const action = await applyRepository(source, options, runner);
          completed += 1;
          options.onProgress?.({
            action,
            current: completed,
            repository: source.id,
            status: 'progress',
            total,
          });
          return action;
        }
      ))
    );
  }
  options.onProgress?.({
    current: actions.length,
    status: 'done',
    total,
  });

  const errors = actions.filter(
    (action) => action.status === 'error' || action.status === 'missing-mirror'
  );

  return {
    actions,
    dryRun: options.dryRun === true,
    errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    gitConfigRewriteRules: createGitConfigRewriteRules(options.manifest, options.giteaBaseUrl),
    mirrorsDir,
    missingMirrors: actions.filter((action) => action.status === 'missing-mirror').length,
    planned: actions.filter((action) => action.status === 'planned').length,
    pushed: actions.filter((action) => action.status === 'pushed').length,
    totalRepositories: actions.length,
  };
}
