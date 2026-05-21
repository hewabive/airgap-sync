import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import type { RepositoryUpdateReport, RepositoryUpdateResult } from '../types.js';

const ignoredDirectoryNames = new Set([
  '.git',
  '.hg',
  '.svn',
  '.turbo',
  '.yarn',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'tmp',
]);

export interface GitOutputCommandInvocation {
  args: string[];
  cwd?: string;
}

export interface GitOutputCommandResult {
  stderr: string;
  stdout: string;
}

export type GitOutputCommandRunner = (
  invocation: GitOutputCommandInvocation
) => Promise<GitOutputCommandResult>;

export interface UpdateRepositoriesOptions {
  dryRun?: boolean;
  generatedAt?: string;
  root: string;
  runner?: GitOutputCommandRunner;
}

export async function runGitOutputCommand(
  invocation: GitOutputCommandInvocation
): Promise<GitOutputCommandResult> {
  return await new Promise<GitOutputCommandResult>((resolve, reject) => {
    const child = spawn('git', invocation.args, {
      cwd: invocation.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const stderrText = Buffer.concat(stderr).toString('utf8');
      const stdoutText = Buffer.concat(stdout).toString('utf8');

      if (code === 0) {
        resolve({ stderr: stderrText, stdout: stdoutText });
        return;
      }

      const message =
        stderrText.trim() || `git ${invocation.args.join(' ')} exited with code ${String(code)}`;
      reject(new Error(message));
    });
  });
}

async function isGitRepositoryDirectory(directory: string): Promise<boolean> {
  return await fs.pathExists(path.join(directory, '.git'));
}

async function scanRepositories(root: string, repositories: string[]): Promise<void> {
  if (await isGitRepositoryDirectory(root)) {
    repositories.push(root);
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredDirectoryNames.has(entry.name)) {
      continue;
    }

    await scanRepositories(path.join(root, entry.name), repositories);
  }
}

export async function findGitRepositories(root: string): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const repositories: string[] = [];
  await scanRepositories(resolvedRoot, repositories);
  return repositories.sort();
}

function errorResult(repository: string, error: unknown): RepositoryUpdateResult {
  return {
    error: (error as Error).message,
    repository,
    status: 'error',
  };
}

async function updateRepository(
  repository: string,
  dryRun: boolean,
  runner: GitOutputCommandRunner
): Promise<RepositoryUpdateResult> {
  try {
    const status = await runner({
      args: ['status', '--porcelain'],
      cwd: repository,
    });
    if (status.stdout.trim().length > 0) {
      return {
        error: 'Working tree has uncommitted changes',
        repository,
        status: 'dirty',
      };
    }

    const branch = await runner({
      args: ['rev-parse', '--abbrev-ref', 'HEAD'],
      cwd: repository,
    });
    if (branch.stdout.trim() === 'HEAD') {
      return {
        error: 'Repository is in detached HEAD state',
        repository,
        status: 'detached',
      };
    }

    if (dryRun) {
      return {
        repository,
        status: 'planned',
      };
    }

    await runner({
      args: ['pull', '--ff-only'],
      cwd: repository,
    });

    return {
      repository,
      status: 'updated',
    };
  } catch (error) {
    return errorResult(repository, error);
  }
}

export async function updateRepositories(
  options: UpdateRepositoriesOptions
): Promise<RepositoryUpdateReport> {
  const root = path.resolve(options.root);
  const runner = options.runner ?? runGitOutputCommand;
  const repositories = await findGitRepositories(root);
  const results: RepositoryUpdateResult[] = [];

  for (const repository of repositories) {
    results.push(await updateRepository(repository, options.dryRun === true, runner));
  }

  const errors = results.filter(
    (result) =>
      result.status === 'dirty' || result.status === 'detached' || result.status === 'error'
  );

  return {
    detached: results.filter((result) => result.status === 'detached').length,
    dirty: results.filter((result) => result.status === 'dirty').length,
    dryRun: options.dryRun === true,
    errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    planned: results.filter((result) => result.status === 'planned').length,
    repositories: results,
    root,
    totalRepositories: results.length,
    updated: results.filter((result) => result.status === 'updated').length,
  };
}
