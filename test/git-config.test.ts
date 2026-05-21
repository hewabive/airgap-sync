import { describe, expect, it } from 'vitest';
import { configureGitRewrites, type GitCommandInvocation } from '../src/index.js';
import type { GitSourcesManifest } from '../src/types.js';

const manifest: GitSourcesManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-21T00:00:00.000Z',
  sources: [
    {
      host: 'github.com',
      id: 'github.com/owner/repo',
      localMirrorPath: 'git-mirrors/github.com/owner/repo.git',
      owner: 'owner',
      repo: 'repo',
      requirements: [],
      sourceUrl: 'https://github.com/owner/repo.git',
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
        generatedAt: '2026-05-21T00:00:00.000Z',
        giteaBaseUrl: 'http://gitea.local',
        manifest,
        runner: (invocation) => {
          calls.push(invocation);
          return Promise.resolve();
        },
      })
    ).resolves.toEqual({
      configured: 0,
      dryRun: true,
      errors: [],
      generatedAt: '2026-05-21T00:00:00.000Z',
      planned: 1,
      scope: 'global',
      totalRules: 1,
    });
    expect(calls).toEqual([]);
  });

  it('writes global git config rewrites', async () => {
    const calls: GitCommandInvocation[] = [];

    const report = await configureGitRewrites({
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local/',
      manifest,
      runner: (invocation) => {
        calls.push(invocation);
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      {
        args: ['config', '--global', 'url.http://gitea.local/.insteadOf', 'https://github.com/'],
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
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      runner: () => Promise.reject(new Error('permission denied')),
    });

    expect(report).toMatchObject({
      configured: 0,
      errors: [
        {
          error: 'permission denied',
          insteadOf: 'https://github.com/',
          status: 'error',
          targetUrl: 'http://gitea.local/',
        },
      ],
    });
  });
});
