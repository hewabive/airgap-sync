import path from 'node:path';
import fs from 'fs-extra';
import type {
  GitApplyActionResult,
  GitApplyReport,
  GitConfigRewriteRule,
  GitMirrorPlan,
  GitMirrorRepositoryPlan,
} from '../types.js';
import { runGitCommand, type GitCommandRunner } from './git-fetch.js';

export interface ApplyGitMirrorsOptions {
  bundleDir: string;
  dryRun?: boolean;
  generatedAt?: string;
  mirrorsDir?: string;
  plan: GitMirrorPlan;
  runner?: GitCommandRunner;
}

function mirrorPath(mirrorsDir: string, repository: GitMirrorRepositoryPlan): string {
  return path.join(mirrorsDir, `${repository.repository}.git`);
}

function quoteGitConfigPart(value: string): string {
  return JSON.stringify(value);
}

export function createGitConfigRewriteRules(plan: GitMirrorPlan): GitConfigRewriteRule[] {
  const seen = new Set<string>();
  const rules: GitConfigRewriteRule[] = [];

  for (const repository of plan.repositories) {
    for (const insteadOf of repository.insteadOf) {
      const key = `${repository.targetUrl}\0${insteadOf}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      rules.push({
        command: `git config --global url.${quoteGitConfigPart(repository.targetUrl)}.insteadOf ${quoteGitConfigPart(insteadOf)}`,
        insteadOf,
        targetUrl: repository.targetUrl,
      });
    }
  }

  return rules.sort((left, right) => {
    const byTarget = left.targetUrl.localeCompare(right.targetUrl);
    return byTarget === 0 ? left.insteadOf.localeCompare(right.insteadOf) : byTarget;
  });
}

async function applyRepository(
  repository: GitMirrorRepositoryPlan,
  mirrorsDir: string,
  runner: GitCommandRunner
): Promise<GitApplyActionResult> {
  const sourcePath = mirrorPath(mirrorsDir, repository);

  if (!(await fs.pathExists(sourcePath))) {
    return {
      repository: repository.repository,
      sourcePath,
      status: 'missing-mirror',
      targetUrl: repository.targetUrl,
    };
  }

  try {
    await runner({
      args: ['-C', sourcePath, 'push', '--mirror', repository.targetUrl],
    });
    return {
      repository: repository.repository,
      sourcePath,
      status: 'pushed',
      targetUrl: repository.targetUrl,
    };
  } catch (error) {
    return {
      error: (error as Error).message,
      repository: repository.repository,
      sourcePath,
      status: 'error',
      targetUrl: repository.targetUrl,
    };
  }
}

export async function applyGitMirrors(options: ApplyGitMirrorsOptions): Promise<GitApplyReport> {
  const mirrorsDir = path.resolve(
    options.mirrorsDir ?? path.join(options.bundleDir, 'git-mirrors')
  );
  const actions: GitApplyActionResult[] = [];

  if (options.dryRun === true) {
    for (const repository of options.plan.repositories) {
      actions.push({
        repository: repository.repository,
        sourcePath: mirrorPath(mirrorsDir, repository),
        status: 'planned',
        targetUrl: repository.targetUrl,
      });
    }
  } else {
    const runner = options.runner ?? runGitCommand;
    for (const repository of options.plan.repositories) {
      actions.push(await applyRepository(repository, mirrorsDir, runner));
    }
  }

  const errors = actions.filter(
    (action) => action.status === 'error' || action.status === 'missing-mirror'
  );

  return {
    dryRun: options.dryRun === true,
    errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    gitConfigRewriteRules: createGitConfigRewriteRules(options.plan),
    mirrorsDir,
    missingMirrors: actions.filter((action) => action.status === 'missing-mirror').length,
    planned: actions.filter((action) => action.status === 'planned').length,
    pushed: actions.filter((action) => action.status === 'pushed').length,
    totalRepositories: actions.length,
  };
}
