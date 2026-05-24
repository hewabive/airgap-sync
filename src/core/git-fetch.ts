import { spawn } from 'node:child_process';
import path from 'node:path';
import * as fs from './fs.js';
import type { GitFetchActionResult, GitFetchReport, GitSourcesManifest } from '../types.js';
import { gitSourceMirrorPath } from './git-targets.js';

export interface GitCommandInvocation {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface GitCommandResult {
  stderr: string;
  stdout: string;
}

export type GitCommandRunner = (
  invocation: GitCommandInvocation
) => Promise<GitCommandResult | undefined> | Promise<void>;

export interface FetchGitSourcesOptions {
  bundleDir: string;
  dryRun?: boolean;
  generatedAt?: string;
  manifest: GitSourcesManifest;
  mirrorsDir?: string;
  onProgress?: (event: GitFetchProgressEvent) => void;
  runner?: GitCommandRunner;
}

export type GitFetchProgressStatus = 'start' | 'progress' | 'done';

export interface GitFetchProgressEvent {
  current: number;
  repository?: string;
  status: GitFetchProgressStatus;
  total: number;
}

interface FetchEntry {
  id: string;
  sourceUrl: string;
  targetPath: string;
}

function redactGitArg(arg: string): string {
  return arg.startsWith('http.extraHeader=') ? 'http.extraHeader=<redacted>' : arg;
}

export async function runGitCommand(invocation: GitCommandInvocation): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve, reject) => {
    const child = spawn('git', invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, ...invocation.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          stderr: Buffer.concat(stderr).toString('utf8'),
          stdout: Buffer.concat(stdout).toString('utf8'),
        });
        return;
      }

      const message = Buffer.concat(stderr).toString('utf8').trim();
      reject(
        new Error(
          message ||
            `git ${invocation.args.map(redactGitArg).join(' ')} exited with code ${String(code)}`
        )
      );
    });
  });
}

function normalizeRefs(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
    .join('\n');
}

async function refsFingerprint(
  targetPath: string,
  runner: GitCommandRunner
): Promise<string | undefined> {
  const result = await runner({
    args: ['-C', targetPath, 'for-each-ref', '--format=%(refname) %(objectname)'],
  });

  return result ? normalizeRefs(result.stdout) : undefined;
}

async function fetchEntry(
  entry: FetchEntry,
  runner: GitCommandRunner
): Promise<GitFetchActionResult> {
  try {
    if (await fs.pathExists(entry.targetPath)) {
      const before = await refsFingerprint(entry.targetPath, runner);
      await runner({
        args: ['-C', entry.targetPath, 'remote', 'set-url', 'origin', entry.sourceUrl],
      });
      await runner({
        args: ['-C', entry.targetPath, 'remote', 'update', '--prune'],
      });
      const after = await refsFingerprint(entry.targetPath, runner);
      return {
        ...(before !== undefined && after !== undefined ? { changed: before !== after } : {}),
        repository: entry.id,
        sourceUrl: entry.sourceUrl,
        status: 'updated',
        targetPath: entry.targetPath,
      };
    }

    await fs.ensureDir(path.dirname(entry.targetPath));
    await runner({
      args: ['clone', '--mirror', entry.sourceUrl, entry.targetPath],
    });
    return {
      changed: true,
      repository: entry.id,
      sourceUrl: entry.sourceUrl,
      status: 'cloned',
      targetPath: entry.targetPath,
    };
  } catch (error) {
    return {
      error: (error as Error).message,
      repository: entry.id,
      sourceUrl: entry.sourceUrl,
      status: 'error',
      targetPath: entry.targetPath,
    };
  }
}

async function fetchEntries(options: {
  dryRun: boolean;
  entries: FetchEntry[];
  generatedAt?: string;
  mirrorsDir: string;
  onProgress?: (event: GitFetchProgressEvent) => void;
  runner?: GitCommandRunner;
}): Promise<GitFetchReport> {
  const actions: GitFetchActionResult[] = [];
  options.onProgress?.({
    current: 0,
    status: 'start',
    total: options.entries.length,
  });

  if (options.dryRun) {
    for (const entry of options.entries) {
      actions.push({
        repository: entry.id,
        sourceUrl: entry.sourceUrl,
        status: 'planned',
        targetPath: entry.targetPath,
      });
    }
  } else {
    const runner = options.runner ?? runGitCommand;
    for (const [index, entry] of options.entries.entries()) {
      actions.push(await fetchEntry(entry, runner));
      options.onProgress?.({
        current: index + 1,
        repository: entry.id,
        status: 'progress',
        total: options.entries.length,
      });
    }
  }
  options.onProgress?.({
    current: actions.length,
    status: 'done',
    total: options.entries.length,
  });

  const errors = actions.filter((action) => action.status === 'error');

  return {
    actions,
    changed: actions.filter((action) => action.changed === true).length,
    cloned: actions.filter((action) => action.status === 'cloned').length,
    dryRun: options.dryRun,
    errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mirrorsDir: options.mirrorsDir,
    planned: actions.filter((action) => action.status === 'planned').length,
    totalRepositories: actions.length,
    unchanged: actions.filter((action) => action.changed === false).length,
    updated: actions.filter((action) => action.status === 'updated').length,
  };
}

export async function fetchGitSources(options: FetchGitSourcesOptions): Promise<GitFetchReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const defaultMirrorRoot = path.join(bundleDir, 'git-mirrors');
  const mirrorsDir = path.resolve(options.mirrorsDir ?? defaultMirrorRoot);
  const entries = options.manifest.sources.map((source) => ({
    id: source.id,
    sourceUrl: source.sourceUrl,
    targetPath: gitSourceMirrorPath({
      bundleDir,
      ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
      source,
    }),
  }));

  return await fetchEntries({
    dryRun: options.dryRun === true,
    entries,
    mirrorsDir,
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
  });
}
