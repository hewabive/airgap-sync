import { describe, expect, it } from 'vitest';
import { provisionGiteaRepositories, type GiteaClient } from '../src/index.js';
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

describe('provisionGiteaRepositories', () => {
  it('plans repository creation without calling Gitea in dry-run mode', async () => {
    const calls: string[] = [];
    const client: GiteaClient = {
      createRepository: () => {
        calls.push('create');
        return Promise.resolve();
      },
      repositoryExists: () => {
        calls.push('exists');
        return Promise.resolve(false);
      },
    };

    await expect(
      provisionGiteaRepositories({
        client,
        dryRun: true,
        generatedAt: '2026-05-20T00:00:00.000Z',
        ownerType: 'org',
        plan,
      })
    ).resolves.toEqual({
      created: 0,
      dryRun: true,
      errors: [],
      exists: 0,
      generatedAt: '2026-05-20T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      owner: 'npm-mirrors',
      ownerType: 'org',
      planned: 1,
      private: true,
      totalRepositories: 1,
    });
    expect(calls).toEqual([]);
  });

  it('skips repositories that already exist', async () => {
    const client: GiteaClient = {
      createRepository: () => {
        throw new Error('create should not be called');
      },
      repositoryExists: () => Promise.resolve(true),
    };

    const report = await provisionGiteaRepositories({
      client,
      generatedAt: '2026-05-20T00:00:00.000Z',
      ownerType: 'user',
      plan,
    });

    expect(report).toMatchObject({
      created: 0,
      errors: [],
      exists: 1,
      planned: 0,
      totalRepositories: 1,
    });
  });

  it('creates missing repositories', async () => {
    const createCalls: unknown[] = [];
    const client: GiteaClient = {
      createRepository: (options) => {
        createCalls.push(options);
        return Promise.resolve();
      },
      repositoryExists: () => Promise.resolve(false),
    };

    const report = await provisionGiteaRepositories({
      client,
      generatedAt: '2026-05-20T00:00:00.000Z',
      ownerType: 'org',
      plan,
      private: false,
    });

    expect(createCalls).toEqual([
      {
        description: 'airgap-sync mirror for github.com/owner/repo',
        name: 'github.com-owner-repo',
        owner: 'npm-mirrors',
        ownerType: 'org',
        private: false,
      },
    ]);
    expect(report).toMatchObject({
      created: 1,
      errors: [],
      exists: 0,
      private: false,
    });
  });

  it('records Gitea errors', async () => {
    const client: GiteaClient = {
      createRepository: () => Promise.reject(new Error('create failed')),
      repositoryExists: () => Promise.resolve(false),
    };

    const report = await provisionGiteaRepositories({
      client,
      generatedAt: '2026-05-20T00:00:00.000Z',
      ownerType: 'user',
      plan,
    });

    expect(report).toMatchObject({
      created: 0,
      errors: [
        {
          error: 'create failed',
          private: true,
          repository: 'github.com-owner-repo',
          status: 'error',
          targetUrl: 'http://gitea.local/npm-mirrors/github.com-owner-repo.git',
        },
      ],
      exists: 0,
    });
  });
});
