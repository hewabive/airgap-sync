import { describe, expect, it } from 'vitest';
import { provisionGiteaRepositories, type GiteaClient } from '../src/index.js';
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
        generatedAt: '2026-05-21T00:00:00.000Z',
        giteaBaseUrl: 'http://gitea.local/',
        manifest,
      })
    ).resolves.toEqual({
      created: 0,
      dryRun: true,
      errors: [],
      exists: 0,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
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
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
    });

    expect(report).toMatchObject({
      created: 0,
      errors: [],
      exists: 1,
      planned: 0,
      totalRepositories: 1,
    });
  });

  it('creates missing repositories preserving original owner and repo names', async () => {
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
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      private: false,
    });

    expect(createCalls).toEqual([
      {
        description: 'airgap-sync mirror for github.com/owner/repo',
        name: 'repo',
        owner: 'owner',
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
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
    });

    expect(report).toMatchObject({
      created: 0,
      errors: [
        {
          error: 'create failed',
          owner: 'owner',
          private: true,
          repository: 'repo',
          status: 'error',
          targetUrl: 'http://gitea.local/owner/repo.git',
        },
      ],
      exists: 0,
    });
  });
});
