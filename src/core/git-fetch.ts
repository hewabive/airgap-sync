import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import type { GitFetchActionResult, GitFetchReport, GitSourcesManifest } from '../types.js';
import { gitSourceMirrorPath } from './git-targets.js';

export interface GitCommandInvocation {
  args: string[];
  cwd?: string;
}

export type GitCommandRunner = (invocation: GitCommandInvocation) => Promise<void>;

export interface FetchGitSourcesOptions {
  bundleDir: string;
  dryRun?: boolean;
  generatedAt?: string;
  manifest: GitSourcesManifest;
  mirrorsDir?: string;
  runner?: GitCommandRunner;
}

interface FetchEntry {
  id: string;
  sourceUrl: string;
  targetPath: string;
}

export async function runGitCommand(invocation: GitCommandInvocation): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', invocation.args, {
      cwd: invocation.cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr: Buffer[] = [];

    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const message = Buffer.concat(stderr).toString('utf8').trim();
      reject(
        new Error(message || `git ${invocation.args.join(' ')} exited with code ${String(code)}`)
      );
    });
  });
}

async function fetchEntry(
  entry: FetchEntry,
  runner: GitCommandRunner
): Promise<GitFetchActionResult> {
  try {
    if (await fs.pathExists(entry.targetPath)) {
      await runner({
        args: ['-C', entry.targetPath, 'remote', 'set-url', 'origin', entry.sourceUrl],
      });
      await runner({
        args: ['-C', entry.targetPath, 'remote', 'update', '--prune'],
      });
      return {
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
  runner?: GitCommandRunner;
}): Promise<GitFetchReport> {
  const actions: GitFetchActionResult[] = [];

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
    for (const entry of options.entries) {
      actions.push(await fetchEntry(entry, runner));
    }
  }

  const errors = actions.filter((action) => action.status === 'error');

  return {
    cloned: actions.filter((action) => action.status === 'cloned').length,
    dryRun: options.dryRun,
    errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mirrorsDir: options.mirrorsDir,
    planned: actions.filter((action) => action.status === 'planned').length,
    totalRepositories: actions.length,
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
    ...(options.runner ? { runner: options.runner } : {}),
  });
}
