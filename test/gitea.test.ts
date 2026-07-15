import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpGiteaClient, provisionGiteaRepositories, type GiteaClient } from '../src/index.js';
import type { GitSourcesManifest } from '../src/types.js';

const fetchMock = vi.fn<typeof fetch>();

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

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpGiteaClient', () => {
  it('checks repositories through the Gitea API', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const client = new HttpGiteaClient('http://gitea.local/', {
      authToken: 'secret',
    });

    await expect(client.repositoryExists('owner', 'repo')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe('http://gitea.local/api/v1/repos/owner/repo');
    expect(firstCall?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'token secret',
      },
      method: 'GET',
    });
    expect(firstCall?.[1]?.signal).toBeDefined();
  });

  it('reads the authenticated user login', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ login: 'maxim' }), {
        status: 200,
      })
    );
    const client = new HttpGiteaClient('http://gitea.local/', {
      authToken: 'secret',
    });

    await expect(client.currentUserLogin()).resolves.toBe('maxim');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe('http://gitea.local/api/v1/user');
    expect(firstCall?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'token secret',
      },
      method: 'GET',
    });
  });

  it('creates repositories for the authenticated user through /user/repos', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    const client = new HttpGiteaClient('http://gitea.local/', {
      authToken: 'secret',
    });

    await client.createRepository({
      description: 'mirror',
      name: 'vllm-project--vllm',
      owner: 'maxim',
      ownerKind: 'user',
      private: true,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gitea.local/api/v1/user/repos');
  });

  it('surfaces Gitea JSON error messages in provision reports', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'repo lookup failed' }), {
        status: 500,
      })
    );
    const client = new HttpGiteaClient('http://gitea.local', {
      authToken: 'secret',
    });

    await expect(
      provisionGiteaRepositories({
        client,
        generatedAt: '2026-05-21T00:00:00.000Z',
        giteaBaseUrl: 'http://gitea.local',
        manifest,
      })
    ).resolves.toMatchObject({
      errors: [
        {
          error: 'repo lookup failed',
          repository: 'repo',
          status: 'error',
        },
      ],
    });
  });
});

describe('provisionGiteaRepositories', () => {
  it('does not try to provision an organization for a user-owned repository', async () => {
    const userManifest: GitSourcesManifest = {
      ...manifest,
      sources: manifest.sources.map((source) => ({
        ...source,
        publishOwner: 'maxim',
        publishOwnerKind: 'user',
        publishRepo: 'owner--repo',
      })),
    };
    const createCalls: unknown[] = [];
    const client: GiteaClient = {
      createOrganization: () => {
        throw new Error('organization creation must not be called');
      },
      createRepository: (options) => {
        createCalls.push(options);
        return Promise.resolve();
      },
      organizationExists: () => {
        throw new Error('organization lookup must not be called');
      },
      repositoryExists: () => Promise.resolve(false),
    };

    const report = await provisionGiteaRepositories({
      client,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest: userManifest,
    });

    expect(report.totalOrganizations).toBe(0);
    expect(createCalls).toEqual([
      expect.objectContaining({
        name: 'owner--repo',
        owner: 'maxim',
        ownerKind: 'user',
      }),
    ]);
  });

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
        visibility: 'public',
      },
    ]);
    expect(createCalls).toEqual([
      {
        description: 'airgap-sync mirror for github.com/owner/repo',
        name: 'repo',
        owner: 'owner',
        ownerKind: 'organization',
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
