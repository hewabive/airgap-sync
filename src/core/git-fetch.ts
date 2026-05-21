import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import type {
  GitFetchActionResult,
  GitFetchReport,
  GitMirrorPlan,
  GitMirrorRepositoryPlan,
} from '../types.js';

export interface GitCommandInvocation {
  args: string[];
  cwd?: string;
}

export type GitCommandRunner = (invocation: GitCommandInvocation) => Promise<void>;

export interface FetchGitMirrorsOptions {
  bundleDir: string;
  dryRun?: boolean;
  generatedAt?: string;
  mirrorsDir?: string;
  plan: GitMirrorPlan;
  runner?: GitCommandRunner;
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

function mirrorPath(mirrorsDir: string, repository: GitMirrorRepositoryPlan): string {
  return path.join(mirrorsDir, `${repository.repository}.git`);
}

async function fetchRepository(
  repository: GitMirrorRepositoryPlan,
  mirrorsDir: string,
  runner: GitCommandRunner
): Promise<GitFetchActionResult> {
  const targetPath = mirrorPath(mirrorsDir, repository);

  try {
    if (await fs.pathExists(targetPath)) {
      await runner({
        args: ['-C', targetPath, 'remote', 'set-url', 'origin', repository.sourceUrl],
      });
      await runner({
        args: ['-C', targetPath, 'remote', 'update', '--prune'],
      });
      return {
        repository: repository.repository,
        sourceUrl: repository.sourceUrl,
        status: 'updated',
        targetPath,
      };
    }

    await fs.ensureDir(mirrorsDir);
    await runner({
      args: ['clone', '--mirror', repository.sourceUrl, targetPath],
    });
    return {
      repository: repository.repository,
      sourceUrl: repository.sourceUrl,
      status: 'cloned',
      targetPath,
    };
  } catch (error) {
    return {
      error: (error as Error).message,
      repository: repository.repository,
      sourceUrl: repository.sourceUrl,
      status: 'error',
      targetPath,
    };
  }
}

export async function fetchGitMirrors(options: FetchGitMirrorsOptions): Promise<GitFetchReport> {
  const mirrorsDir = path.resolve(
    options.mirrorsDir ?? path.join(options.bundleDir, 'git-mirrors')
  );
  const actions: GitFetchActionResult[] = [];

  if (options.dryRun === true) {
    for (const repository of options.plan.repositories) {
      actions.push({
        repository: repository.repository,
        sourceUrl: repository.sourceUrl,
        status: 'planned',
        targetPath: mirrorPath(mirrorsDir, repository),
      });
    }
  } else {
    const runner = options.runner ?? runGitCommand;
    for (const repository of options.plan.repositories) {
      actions.push(await fetchRepository(repository, mirrorsDir, runner));
    }
  }

  const errors = actions.filter((action) => action.status === 'error');

  return {
    cloned: actions.filter((action) => action.status === 'cloned').length,
    dryRun: options.dryRun === true,
    errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mirrorsDir,
    planned: actions.filter((action) => action.status === 'planned').length,
    totalRepositories: actions.length,
    updated: actions.filter((action) => action.status === 'updated').length,
  };
}
