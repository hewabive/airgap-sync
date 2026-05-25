import path from 'node:path';
import * as fs from './fs.js';
import type {
  GitApplyActionResult,
  GitApplyReport,
  GitConfigRewriteRule,
  GitSource,
  GitSourcesManifest,
} from '../types.js';
import { runGitCommand, type GitCommandRunner } from './git-fetch.js';
import { safeDirectoryGitArgs } from './git-safe.js';
import { gitSourceMirrorPath, gitSourceTargetUrl, normalizeBaseUrl } from './git-targets.js';

export interface ApplyGitSourcesOptions {
  bundleDir: string;
  dryRun?: boolean;
  giteaBaseUrl: string;
  generatedAt?: string;
  gitAuth?: GitHttpAuth;
  manifest: GitSourcesManifest;
  mirrorsDir?: string;
  runner?: GitCommandRunner;
}

export interface GitHttpAuth {
  password: string;
  username: string;
}

function quoteGitConfigPart(value: string): string {
  return JSON.stringify(value);
}

export function createGitConfigRewriteRules(
  manifest: GitSourcesManifest,
  giteaBaseUrl: string
): GitConfigRewriteRule[] {
  const seen = new Set<string>();
  const targetUrl = `${normalizeBaseUrl(giteaBaseUrl)}/`;

  for (const source of manifest.sources) {
    seen.add(`git@${source.host}:`);
    seen.add(`https://${source.host}/`);
    seen.add(`ssh://git@${source.host}/`);
  }

  return [...seen]
    .map((insteadOf) => ({
      command: `git config --global --add url.${quoteGitConfigPart(targetUrl)}.insteadOf ${quoteGitConfigPart(insteadOf)}`,
      insteadOf,
      targetUrl,
    }))
    .sort((left, right) => left.insteadOf.localeCompare(right.insteadOf));
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

function pushEnv(): NodeJS.ProcessEnv {
  return {
    GCM_INTERACTIVE: 'never',
    GIT_TERMINAL_PROMPT: '0',
  };
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

  if (!(await fs.pathExists(mirrorPath))) {
    return {
      repository: source.id,
      sourcePath: mirrorPath,
      status: 'missing-mirror',
      targetUrl,
    };
  }

  try {
    await runner({
      args: pushArgs(mirrorPath, targetUrl, options.gitAuth),
      ...(options.gitAuth ? { env: pushEnv() } : {}),
    });
    return {
      repository: source.id,
      sourcePath: mirrorPath,
      status: 'pushed',
      targetUrl,
    };
  } catch (error) {
    return {
      error: summarizeErrorMessage((error as Error).message),
      repository: source.id,
      sourcePath: mirrorPath,
      status: 'error',
      targetUrl,
    };
  }
}

export async function applyGitSources(options: ApplyGitSourcesOptions): Promise<GitApplyReport> {
  const mirrorsDir = path.resolve(
    options.mirrorsDir ?? path.join(options.bundleDir, 'git-mirrors')
  );
  const actions: GitApplyActionResult[] = [];

  if (options.dryRun === true) {
    for (const source of options.manifest.sources) {
      actions.push({
        repository: source.id,
        sourcePath: sourcePath(source, options),
        status: 'planned',
        targetUrl: gitSourceTargetUrl(source, options.giteaBaseUrl),
      });
    }
  } else {
    const runner = options.runner ?? runGitCommand;
    for (const source of options.manifest.sources) {
      actions.push(await applyRepository(source, options, runner));
    }
  }

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
