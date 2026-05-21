import type {
  GitConfigActionResult,
  GitConfigReport,
  GitConfigRewriteRule,
  GitSourcesManifest,
} from '../types.js';
import { runGitCommand, type GitCommandRunner } from './git-fetch.js';
import { createGitConfigRewriteRules } from './git-apply.js';

export interface ConfigureGitRewritesOptions {
  dryRun?: boolean;
  giteaBaseUrl: string;
  generatedAt?: string;
  manifest: GitSourcesManifest;
  runner?: GitCommandRunner;
}

function gitConfigKey(rule: GitConfigRewriteRule): string {
  return `url.${rule.targetUrl}.insteadOf`;
}

async function configureRule(
  rule: GitConfigRewriteRule,
  runner: GitCommandRunner
): Promise<GitConfigActionResult> {
  try {
    await runner({
      args: ['config', '--global', '--add', gitConfigKey(rule), rule.insteadOf],
    });
    return {
      insteadOf: rule.insteadOf,
      status: 'configured',
      targetUrl: rule.targetUrl,
    };
  } catch (error) {
    return {
      error: (error as Error).message,
      insteadOf: rule.insteadOf,
      status: 'error',
      targetUrl: rule.targetUrl,
    };
  }
}

export async function configureGitRewrites(
  options: ConfigureGitRewritesOptions
): Promise<GitConfigReport> {
  const rules = createGitConfigRewriteRules(options.manifest, options.giteaBaseUrl);
  const actions: GitConfigActionResult[] = [];

  if (options.dryRun === true) {
    for (const rule of rules) {
      actions.push({
        insteadOf: rule.insteadOf,
        status: 'planned',
        targetUrl: rule.targetUrl,
      });
    }
  } else {
    const runner = options.runner ?? runGitCommand;
    for (const rule of rules) {
      actions.push(await configureRule(rule, runner));
    }
  }

  const errors = actions.filter((action) => action.status === 'error');

  return {
    configured: actions.filter((action) => action.status === 'configured').length,
    dryRun: options.dryRun === true,
    errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    planned: actions.filter((action) => action.status === 'planned').length,
    scope: 'global',
    totalRules: actions.length,
  };
}
