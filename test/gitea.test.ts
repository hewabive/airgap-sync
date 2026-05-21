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
      createOrganization: () => {
        calls.push('create-organization');
        return Promise.resolve();
      },
      createRepository: () => {
        calls.push('create-repository');
        return Promise.resolve();
      },
      organizationExists: () => {
        calls.push('organization-exists');
        return Promise.resolve(false);
      },
      repositoryExists: () => {
        calls.push('repository-exists');
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
      organizationCreated: 0,
      organizationErrors: [],
      organizationExists: 0,
      organizationPlanned: 1,
      organizations: [
        {
          owner: 'owner',
          status: 'planned',
        },
      ],
      planned: 1,
      private: true,
      totalOrganizations: 1,
      totalRepositories: 1,
    });
    expect(calls).toEqual([]);
  });

  it('skips repositories that already exist', async () => {
    const client: GiteaClient = {
      createOrganization: () => {
        throw new Error('create organization should not be called');
      },
      createRepository: () => {
        throw new Error('create should not be called');
      },
      organizationExists: () => Promise.resolve(true),
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
      organizationCreated: 0,
      organizationErrors: [],
      organizationExists: 1,
      planned: 0,
      totalOrganizations: 1,
      totalRepositories: 1,
    });
  });

  it('creates missing repositories preserving original owner and repo names', async () => {
    const createOrganizationCalls: unknown[] = [];
    const createCalls: unknown[] = [];
    const client: GiteaClient = {
      createOrganization: (options) => {
        createOrganizationCalls.push(options);
        return Promise.resolve();
      },
      createRepository: (options) => {
        createCalls.push(options);
        return Promise.resolve();
      },
      organizationExists: () => Promise.resolve(false),
      repositoryExists: () => Promise.resolve(false),
    };

    const report = await provisionGiteaRepositories({
      client,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      private: false,
    });

    expect(createOrganizationCalls).toEqual([
      {
        fullName: 'airgap-sync mirror owner for owner',
        name: 'owner',
        visibility: 'private',
      },
    ]);
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
      organizationCreated: 1,
      organizationErrors: [],
      private: false,
    });
  });

  it('does not create an organization more than once', async () => {
    const createOrganizationCalls: unknown[] = [];
    const multiSourceManifest: GitSourcesManifest = {
      ...manifest,
      sources: [
        ...manifest.sources,
        {
          host: 'github.com',
          id: 'github.com/owner/other',
          localMirrorPath: 'git-mirrors/github.com/owner/other.git',
          owner: 'owner',
          repo: 'other',
          requirements: [],
          sourceUrl: 'https://github.com/owner/other.git',
        },
      ],
    };
    const client: GiteaClient = {
      createOrganization: (options) => {
        createOrganizationCalls.push(options);
        return Promise.resolve();
      },
      createRepository: () => Promise.resolve(),
      organizationExists: () => Promise.resolve(false),
      repositoryExists: () => Promise.resolve(false),
    };

    const report = await provisionGiteaRepositories({
      client,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest: multiSourceManifest,
    });

    expect(createOrganizationCalls).toHaveLength(1);
    expect(report).toMatchObject({
      created: 2,
      organizationCreated: 1,
      totalOrganizations: 1,
      totalRepositories: 2,
    });
  });

  it('records Gitea errors', async () => {
    const client: GiteaClient = {
      createOrganization: () => Promise.resolve(),
      createRepository: () => Promise.reject(new Error('create failed')),
      organizationExists: () => Promise.resolve(false),
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

  it('records organization errors and skips repository creation under that owner', async () => {
    const client: GiteaClient = {
      createOrganization: () => Promise.reject(new Error('organization create failed')),
      createRepository: () => {
        throw new Error('create repository should not be called');
      },
      organizationExists: () => Promise.resolve(false),
      repositoryExists: () => {
        throw new Error('repository exists should not be called');
      },
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
          error: 'Organization owner could not be provisioned: organization create failed',
          owner: 'owner',
          private: true,
          repository: 'repo',
          status: 'error',
          targetUrl: 'http://gitea.local/owner/repo.git',
        },
      ],
      organizationCreated: 0,
      organizationErrors: [
        {
          error: 'organization create failed',
          owner: 'owner',
          status: 'error',
        },
      ],
    });
  });
});
