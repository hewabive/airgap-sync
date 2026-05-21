import { describe, expect, it } from 'vitest';
import { configureGitRewrites, type GitCommandInvocation } from '../src/index.js';
import type { GitMirrorPlan } from '../src/types.js';

const plan: GitMirrorPlan = {
  schemaVersion: 1,
  createdAt: '2026-05-20T00:00:00.000Z',
  giteaBaseUrl: 'http://gitea.local',
  owner: 'npm-mirrors',
  repositories: [
    {
      id: 'github.com/owner/repo',
      insteadOf: ['https://github.com/owner/repo.git'],
      repository: 'github.com-owner-repo',
      requirements: [],
      sourceUrl: 'https://github.com/owner/repo.git',
      targetUrl: 'http://gitea.local/npm-mirrors/github.com-owner-repo.git',
    },
  ],
  skipped: [],
};

describe('configureGitRewrites', () => {
  it('plans global git config rewrites in dry-run mode', async () => {
    const calls: GitCommandInvocation[] = [];

    await expect(
      configureGitRewrites({
        dryRun: true,
        generatedAt: '2026-05-20T00:00:00.000Z',
        plan,
        runner: (invocation) => {
          calls.push(invocation);
          return Promise.resolve();
        },
      })
    ).resolves.toEqual({
      configured: 0,
      dryRun: true,
      errors: [],
      generatedAt: '2026-05-20T00:00:00.000Z',
      planned: 1,
      scope: 'global',
      totalRules: 1,
    });
    expect(calls).toEqual([]);
  });

  it('writes global git config rewrites', async () => {
    const calls: GitCommandInvocation[] = [];

    const report = await configureGitRewrites({
      generatedAt: '2026-05-20T00:00:00.000Z',
      plan,
      runner: (invocation) => {
        calls.push(invocation);
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      {
        args: [
          'config',
          '--global',
          'url.http://gitea.local/npm-mirrors/github.com-owner-repo.git.insteadOf',
          'https://github.com/owner/repo.git',
        ],
      },
    ]);
    expect(report).toMatchObject({
      configured: 1,
      dryRun: false,
      errors: [],
      planned: 0,
      totalRules: 1,
    });
  });

  it('records git config failures', async () => {
    const report = await configureGitRewrites({
      generatedAt: '2026-05-20T00:00:00.000Z',
      plan,
      runner: () => Promise.reject(new Error('permission denied')),
    });

    expect(report).toMatchObject({
      configured: 0,
      errors: [
        {
          error: 'permission denied',
          insteadOf: 'https://github.com/owner/repo.git',
          status: 'error',
          targetUrl: 'http://gitea.local/npm-mirrors/github.com-owner-repo.git',
        },
      ],
    });
  });
});
