import type {
  GiteaOrganizationActionResult,
  GiteaRepositoryActionResult,
  GiteaRepositoryProvisionReport,
  GitSource,
  GitSourcesManifest,
} from '../types.js';
import {
  gitSourcePublishOwner,
  gitSourcePublishOwnerKind,
  gitSourcePublishRepo,
  gitSourceTargetUrl,
  normalizeBaseUrl,
} from './git-targets.js';

export interface GiteaClient {
  createOrganization(options: {
    fullName: string;
    name: string;
    visibility: 'private' | 'public';
  }): Promise<void>;
  createRepository(options: {
    description: string;
    name: string;
    owner: string;
    ownerKind: 'organization' | 'user';
    private: boolean;
  }): Promise<void>;
  organizationExists(owner: string): Promise<boolean>;
  repositoryExists(owner: string, name: string): Promise<boolean>;
}

interface GiteaCurrentUser {
  login?: unknown;
  username?: unknown;
}

export interface HttpGiteaClientOptions {
  authToken: string;
  timeoutMs?: number;
}

export interface ProvisionGiteaRepositoriesOptions {
  client: GiteaClient;
  dryRun?: boolean;
  giteaBaseUrl: string;
  generatedAt?: string;
  manifest: GitSourcesManifest;
  private?: boolean;
}

export interface AssumeGiteaRepositoriesExistOptions {
  generatedAt?: string;
  giteaBaseUrl: string;
  manifest: GitSourcesManifest;
  private?: boolean;
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

class GiteaApiError extends Error {
  readonly data: unknown;
  readonly status: number;

  constructor(status: number, data: unknown) {
    super(`Gitea API request failed with status ${String(status)}`);
    this.status = status;
    this.data = data;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof GiteaApiError) {
    if (error.data && typeof error.data === 'object' && 'message' in error.data) {
      return String(error.data.message);
    }
    return error.message;
  }

  return (error as Error).message;
}

async function responseData(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function uniqueOwners(manifest: GitSourcesManifest): string[] {
  return [
    ...new Set(
      manifest.sources
        .filter((source) => gitSourcePublishOwnerKind(source) === 'organization')
        .map(gitSourcePublishOwner)
    ),
  ].sort();
}

export class HttpGiteaClient implements GiteaClient {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;

  constructor(giteaBaseUrl: string, options: HttpGiteaClientOptions) {
    this.#baseUrl = `${normalizeBaseUrl(giteaBaseUrl)}/api/v1`;
    this.#headers = {
      Accept: 'application/json',
      Authorization: `token ${options.authToken}`,
    };
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async #request(
    path: string,
    options: {
      body?: unknown;
      method: 'GET' | 'POST';
      validStatuses: Set<number>;
    }
  ): Promise<Response> {
    const headers = { ...this.#headers };
    let body: string | undefined;

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const request: RequestInit = {
      headers,
      method: options.method,
      signal: AbortSignal.timeout(this.#timeoutMs),
    };

    if (body !== undefined) {
      request.body = body;
    }

    const response = await fetch(`${this.#baseUrl}${path}`, request);

    if (!options.validStatuses.has(response.status)) {
      throw new GiteaApiError(response.status, await responseData(response));
    }

    return response;
  }

  async repositoryExists(owner: string, name: string): Promise<boolean> {
    const response = await this.#request(
      `/repos/${encodePathPart(owner)}/${encodePathPart(name)}`,
      {
        method: 'GET',
        validStatuses: new Set([200, 404]),
      }
    );

    return response.status === 200;
  }

  async organizationExists(owner: string): Promise<boolean> {
    const response = await this.#request(`/orgs/${encodePathPart(owner)}`, {
      method: 'GET',
      validStatuses: new Set([200, 404]),
    });

    return response.status === 200;
  }

  async createOrganization(options: {
    fullName: string;
    name: string;
    visibility: 'private' | 'public';
  }): Promise<void> {
    await this.#request('/orgs', {
      body: {
        full_name: options.fullName,
        username: options.name,
        visibility: options.visibility,
      },
      method: 'POST',
      validStatuses: new Set([201]),
    });
  }

  async createRepository(options: {
    description: string;
    name: string;
    owner: string;
    ownerKind: 'organization' | 'user';
    private: boolean;
  }): Promise<void> {
    await this.#request(
      options.ownerKind === 'user'
        ? '/user/repos'
        : `/orgs/${encodePathPart(options.owner)}/repos`,
      {
      body: {
        auto_init: false,
        description: options.description,
        name: options.name,
        private: options.private,
      },
      method: 'POST',
      validStatuses: new Set([201]),
      }
    );
  }

  async currentUserLogin(): Promise<string> {
    const response = await this.#request('/user', {
      method: 'GET',
      validStatuses: new Set([200]),
    });
    const data = (await responseData(response)) as GiteaCurrentUser;
    const login = data.login ?? data.username;

    if (typeof login !== 'string' || login.length === 0) {
      throw new Error('Gitea API did not return the current user login');
    }

    return login;
  }
}

async function provisionOrganization(
  owner: string,
  options: ProvisionGiteaRepositoriesOptions,
  isPrivate: boolean
): Promise<GiteaOrganizationActionResult> {
  try {
    const exists = await options.client.organizationExists(owner);
    if (exists) {
      return {
        owner,
        status: 'exists',
      };
    }

    await options.client.createOrganization({
      fullName: `airgap-sync mirror owner for ${owner}`,
      name: owner,
      visibility: isPrivate ? 'private' : 'public',
    });

    return {
      owner,
      status: 'created',
    };
  } catch (error) {
    return {
      error: errorMessage(error),
      owner,
      status: 'error',
    };
  }
}

async function provisionRepository(
  source: GitSource,
  options: ProvisionGiteaRepositoriesOptions,
  isPrivate: boolean
): Promise<GiteaRepositoryActionResult> {
  const targetUrl = gitSourceTargetUrl(source, options.giteaBaseUrl);
  const owner = gitSourcePublishOwner(source);
  const repo = gitSourcePublishRepo(source);

  try {
    const exists = await options.client.repositoryExists(owner, repo);
    if (exists) {
      return {
        owner,
        private: isPrivate,
        repository: repo,
        status: 'exists',
        targetUrl,
      };
    }

    await options.client.createRepository({
      description: `airgap-sync mirror for ${source.id}`,
      name: repo,
      owner,
      ownerKind: gitSourcePublishOwnerKind(source),
      private: isPrivate,
    });

    return {
      owner,
      private: isPrivate,
      repository: repo,
      status: 'created',
      targetUrl,
    };
  } catch (error) {
    return {
      error: errorMessage(error),
      owner,
      private: isPrivate,
      repository: repo,
      status: 'error',
      targetUrl,
    };
  }
}

function repositoryBlockedByOrganizationError(
  source: GitSource,
  organization: GiteaOrganizationActionResult,
  options: ProvisionGiteaRepositoriesOptions,
  isPrivate: boolean
): GiteaRepositoryActionResult {
  return {
    error: `Organization ${gitSourcePublishOwner(source)} could not be provisioned: ${organization.error ?? 'unknown error'}`,
    owner: gitSourcePublishOwner(source),
    private: isPrivate,
    repository: gitSourcePublishRepo(source),
    status: 'error',
    targetUrl: gitSourceTargetUrl(source, options.giteaBaseUrl),
  };
}

function existingRepositoryAction(
  source: GitSource,
  options: ProvisionGiteaRepositoriesOptions,
  isPrivate: boolean
): GiteaRepositoryActionResult {
  return {
    owner: gitSourcePublishOwner(source),
    private: isPrivate,
    repository: gitSourcePublishRepo(source),
    status: 'exists',
    targetUrl: gitSourceTargetUrl(source, options.giteaBaseUrl),
  };
}

export async function provisionGiteaRepositories(
  options: ProvisionGiteaRepositoriesOptions
): Promise<GiteaRepositoryProvisionReport> {
  const isPrivate = options.private ?? true;
  const actions: GiteaRepositoryActionResult[] = [];
  const organizationActions: GiteaOrganizationActionResult[] = [];
  const organizationActionsByOwner = new Map<string, GiteaOrganizationActionResult>();
  const owners = uniqueOwners(options.manifest);

  if (options.dryRun === true) {
    for (const owner of owners) {
      const action: GiteaOrganizationActionResult = {
        owner,
        status: 'planned',
      };
      organizationActions.push(action);
      organizationActionsByOwner.set(owner, action);
    }

    for (const source of options.manifest.sources) {
      actions.push({
        owner: gitSourcePublishOwner(source),
        private: isPrivate,
        repository: gitSourcePublishRepo(source),
        status: 'planned',
        targetUrl: gitSourceTargetUrl(source, options.giteaBaseUrl),
      });
    }
  } else {
    const missingSources: GitSource[] = [];

    for (const source of options.manifest.sources) {
      try {
        const owner = gitSourcePublishOwner(source);
        const repo = gitSourcePublishRepo(source);
        const exists = await options.client.repositoryExists(owner, repo);
        if (exists) {
          actions.push(existingRepositoryAction(source, options, isPrivate));
          if (
            gitSourcePublishOwnerKind(source) === 'organization' &&
            !organizationActionsByOwner.has(owner)
          ) {
            const action: GiteaOrganizationActionResult = {
              owner,
              status: 'exists',
            };
            organizationActions.push(action);
            organizationActionsByOwner.set(owner, action);
          }
          continue;
        }

        missingSources.push(source);
      } catch (error) {
        actions.push({
          error: errorMessage(error),
          owner: gitSourcePublishOwner(source),
          private: isPrivate,
          repository: gitSourcePublishRepo(source),
          status: 'error',
          targetUrl: gitSourceTargetUrl(source, options.giteaBaseUrl),
        });
      }
    }

    for (const owner of uniqueOwners({ ...options.manifest, sources: missingSources })) {
      if (organizationActionsByOwner.has(owner)) {
        continue;
      }
      const action = await provisionOrganization(owner, options, isPrivate);
      organizationActions.push(action);
      organizationActionsByOwner.set(owner, action);
    }

    for (const source of missingSources) {
      const organization = organizationActionsByOwner.get(gitSourcePublishOwner(source));
      if (organization?.status === 'error') {
        actions.push(
          repositoryBlockedByOrganizationError(source, organization, options, isPrivate)
        );
        continue;
      }

      actions.push(await provisionRepository(source, options, isPrivate));
    }
  }

  const errors = actions.filter((action) => action.status === 'error');
  const organizationErrors = organizationActions.filter((action) => action.status === 'error');

  return {
    created: actions.filter((action) => action.status === 'created').length,
    dryRun: options.dryRun === true,
    errors,
    exists: actions.filter((action) => action.status === 'exists').length,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    giteaBaseUrl: normalizeBaseUrl(options.giteaBaseUrl),
    organizationCreated: organizationActions.filter((action) => action.status === 'created').length,
    organizationErrors,
    organizationExists: organizationActions.filter((action) => action.status === 'exists').length,
    organizationPlanned: organizationActions.filter((action) => action.status === 'planned').length,
    organizations: organizationActions,
    planned: actions.filter((action) => action.status === 'planned').length,
    private: isPrivate,
    totalOrganizations: organizationActions.length,
    totalRepositories: actions.length,
  };
}

export function assumeGiteaRepositoriesExist(
  options: AssumeGiteaRepositoriesExistOptions
): GiteaRepositoryProvisionReport {
  const isPrivate = options.private ?? true;
  const organizationActions: GiteaOrganizationActionResult[] = uniqueOwners(options.manifest).map(
    (owner) => ({
      owner,
      status: 'exists',
    })
  );
  const actions: GiteaRepositoryActionResult[] = options.manifest.sources.map((source) => ({
    owner: gitSourcePublishOwner(source),
    private: isPrivate,
    repository: gitSourcePublishRepo(source),
    status: 'exists',
    targetUrl: gitSourceTargetUrl(source, options.giteaBaseUrl),
  }));

  return {
    created: 0,
    dryRun: false,
    errors: [],
    exists: actions.length,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    giteaBaseUrl: normalizeBaseUrl(options.giteaBaseUrl),
    organizationCreated: 0,
    organizationErrors: [],
    organizationExists: organizationActions.length,
    organizationPlanned: 0,
    organizations: organizationActions,
    planned: 0,
    private: isPrivate,
    totalOrganizations: organizationActions.length,
    totalRepositories: actions.length,
  };
}
