import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpGiteaClient,
  provisionGiteaOwners,
  provisionGiteaRepositories,
  type GiteaClient,
} from '../src/index.js';
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

  it('migrates repositories through the long-running migration endpoint', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    const client = new HttpGiteaClient('http://gitea.local/', {
      authToken: 'secret',
    });

    await client.migrateRepository({
      authPassword: 'source-password',
      authUsername: 'source-user',
      cloneUrl: 'http://127.0.0.1:1234/repositories/source.git',
      description: 'mirror',
      name: 'repo',
      owner: 'owner',
      private: false,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gitea.local/api/v1/repos/migrate');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        auth_password: 'source-password',
        auth_username: 'source-user',
        clone_addr: 'http://127.0.0.1:1234/repositories/source.git',
        description: 'mirror',
        issues: false,
        labels: false,
        lfs: false,
        milestones: false,
        mirror: false,
        private: false,
        pull_requests: false,
        releases: false,
        repo_name: 'repo',
        repo_owner: 'owner',
        service: 'git',
        wiki: false,
      }),
      method: 'POST',
    });
  });

  it('sets a repository default branch through the Gitea API', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const client = new HttpGiteaClient('http://gitea.local/', {
      authToken: 'secret',
    });

    await client.setRepositoryDefaultBranch({
      branch: 'main',
      name: 'repo',
      owner: 'owner',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gitea.local/api/v1/repos/owner/repo');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ default_branch: 'main' }),
      method: 'PATCH',
    });
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

describe('provisionGiteaOwners', () => {
  it('creates one organization for shared PyPI and Generic purposes', async () => {
    const createCalls: unknown[] = [];
    const client: GiteaClient = {
      createOrganization: (options) => {
        createCalls.push(options);
        return Promise.resolve();
      },
      createRepository: () => Promise.resolve(),
      organizationExists: () => Promise.resolve(false),
      repositoryExists: () => Promise.resolve(false),
    };

    const report = await provisionGiteaOwners({
      authenticatedUser: 'publisher',
      client,
      generatedAt: '2026-07-28T00:00:00.000Z',
      requirements: [
        {
          kind: 'organization',
          name: 'airgap-packages',
          purposes: ['pypi'],
          visibility: 'public',
        },
        {
          kind: 'organization',
          name: 'airgap-packages',
          purposes: ['generic'],
          visibility: 'public',
        },
      ],
    });

    expect(createCalls).toEqual([
      {
        fullName: 'airgap-sync managed owner for pypi, generic',
        name: 'airgap-packages',
        visibility: 'public',
      },
    ]);
    expect(report).toMatchObject({
      created: 1,
      errors: [],
      exists: 0,
      planned: 0,
    });
    expect(report.actions[0]).toMatchObject({
      kind: 'organization',
      name: 'airgap-packages',
      purposes: ['pypi', 'generic'],
      status: 'created',
    });
  });

  it('never creates a user and rejects a different authenticated principal', async () => {
    const client: GiteaClient = {
      createOrganization: () => {
        throw new Error('user owners must not create organizations');
      },
      createRepository: () => Promise.resolve(),
      organizationExists: () => {
        throw new Error('user owners must not check organizations');
      },
      repositoryExists: () => Promise.resolve(false),
    };

    const report = await provisionGiteaOwners({
      authenticatedUser: 'publisher',
      client,
      requirements: [
        {
          kind: 'user',
          name: 'other-user',
          purposes: ['pypi'],
          visibility: 'public',
        },
      ],
    });

    expect(report.errors[0]?.error).toContain('must match the authenticated user');
  });

  it('reports dry-run organization creation without API calls', async () => {
    const client: GiteaClient = {
      createOrganization: () => {
        throw new Error('dry-run must not create organizations');
      },
      createRepository: () => Promise.resolve(),
      organizationExists: () => {
        throw new Error('dry-run must not check organizations');
      },
      repositoryExists: () => Promise.resolve(false),
    };

    const report = await provisionGiteaOwners({
      client,
      dryRun: true,
      requirements: [
        {
          kind: 'organization',
          name: 'airgap-packages',
          purposes: ['pypi', 'generic'],
          visibility: 'public',
        },
      ],
    });

    expect(report).toMatchObject({
      created: 0,
      errors: [],
      exists: 0,
      planned: 1,
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

  it('rejects destination collisions before calling Gitea', async () => {
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
    const collidingManifest: GitSourcesManifest = {
      ...manifest,
      sources: [
        manifest.sources[0]!,
        {
          ...manifest.sources[0]!,
          host: 'gitlab.example',
          id: 'gitlab.example/owner/repo',
          localMirrorPath: 'git-mirrors/gitlab.example/owner/repo.git',
          sourceUrl: 'https://gitlab.example/owner/repo.git',
        },
      ],
    };

    await expect(
      provisionGiteaRepositories({
        client,
        giteaBaseUrl: 'http://gitea.local',
        manifest: collidingManifest,
      })
    ).rejects.toThrow(
      'Git publish target collision: owner/repo: github.com/owner/repo and gitlab.example/owner/repo'
    );
    expect(calls).toEqual([]);
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
      migrated: 0,
      migrationFallbacks: [],
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
        fullName: 'airgap-sync managed owner for git',
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

  it('migrates a missing repository when an authenticated source is available', async () => {
    const migrateCalls: unknown[] = [];
    const client: GiteaClient = {
      createOrganization: () => Promise.resolve(),
      createRepository: () => {
        throw new Error('migration must create the repository');
      },
      migrateRepository: (options) => {
        migrateCalls.push(options);
        return Promise.resolve();
      },
      organizationExists: () => Promise.resolve(true),
      repositoryExists: () => Promise.resolve(false),
    };

    const report = await provisionGiteaRepositories({
      client,
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      migrationSource: {
        cloneUrl: () => 'http://source.local/repositories/repo.git',
        credentials: { password: 'source-password', username: 'source-user' },
      },
      private: false,
    });

    expect(migrateCalls).toEqual([
      {
        authPassword: 'source-password',
        authUsername: 'source-user',
        cloneUrl: 'http://source.local/repositories/repo.git',
        description: 'airgap-sync mirror for github.com/owner/repo',
        name: 'repo',
        owner: 'owner',
        private: false,
      },
    ]);
    expect(report).toMatchObject({
      created: 0,
      errors: [],
      migrated: 1,
      migrationFallbacks: [],
    });
  });

  it('falls back to empty creation when migration is unavailable', async () => {
    const createCalls: unknown[] = [];
    let repositoryChecks = 0;
    const client: GiteaClient = {
      createOrganization: () => Promise.resolve(),
      createRepository: (options) => {
        createCalls.push(options);
        return Promise.resolve();
      },
      migrateRepository: () => Promise.reject(new Error('migration host is not allowed')),
      organizationExists: () => Promise.resolve(true),
      repositoryExists: () => {
        repositoryChecks += 1;
        return Promise.resolve(false);
      },
    };

    const report = await provisionGiteaRepositories({
      client,
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      migrationSource: { cloneUrl: () => 'http://127.0.0.1/repo.git' },
    });

    expect(repositoryChecks).toBe(2);
    expect(createCalls).toHaveLength(1);
    expect(report).toMatchObject({
      created: 1,
      errors: [],
      migrated: 0,
      migrationFallbacks: [
        {
          migrationError: 'migration host is not allowed',
          repository: 'repo',
          status: 'created',
        },
      ],
    });
  });

  it('bounds concurrent migrations and reports completion progress', async () => {
    const concurrentManifest: GitSourcesManifest = {
      ...manifest,
      sources: Array.from({ length: 3 }, (_, index) => ({
        ...manifest.sources[0]!,
        id: `github.com/owner/repo-${String(index)}`,
        localMirrorPath: `git-mirrors/github.com/owner/repo-${String(index)}.git`,
        repo: `repo-${String(index)}`,
        sourceUrl: `https://github.com/owner/repo-${String(index)}.git`,
      })),
    };
    let active = 0;
    let maximumActive = 0;
    const progress: number[] = [];
    const client: GiteaClient = {
      createOrganization: () => Promise.resolve(),
      createRepository: () => Promise.reject(new Error('migration should succeed')),
      migrateRepository: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
      },
      organizationExists: () => Promise.resolve(true),
      repositoryExists: () => Promise.resolve(false),
    };

    const report = await provisionGiteaRepositories({
      client,
      concurrency: 2,
      giteaBaseUrl: 'http://gitea.local',
      manifest: concurrentManifest,
      migrationSource: { cloneUrl: (source) => `http://source.local/${source.repo}.git` },
      onProgress: (event) => progress.push(event.current),
    });

    expect(maximumActive).toBe(2);
    expect(progress).toEqual([1, 2, 3]);
    expect(report.migrated).toBe(3);
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
