import axios, { type AxiosInstance } from 'axios';
import type {
  GiteaOrganizationActionResult,
  GiteaRepositoryActionResult,
  GiteaRepositoryProvisionReport,
  GitSource,
  GitSourcesManifest,
} from '../types.js';
import { gitSourceTargetUrl, normalizeBaseUrl } from './git-targets.js';

export interface GiteaClient {
  createOrganization(options: {
    fullName: string;
    name: string;
    visibility: 'private';
  }): Promise<void>;
  createRepository(options: {
    description: string;
    name: string;
    owner: string;
    private: boolean;
  }): Promise<void>;
  organizationExists(owner: string): Promise<boolean>;
  repositoryExists(owner: string, name: string): Promise<boolean>;
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

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const response = error.response;
    const data = response?.data as unknown;
    if (data && typeof data === 'object' && 'message' in data) {
      return String(data.message);
    }
    if (response?.status) {
      return `Gitea API request failed with status ${String(response.status)}`;
    }
  }

  return (error as Error).message;
}

function uniqueOwners(manifest: GitSourcesManifest): string[] {
  return [...new Set(manifest.sources.map((source) => source.owner))].sort();
}

export class HttpGiteaClient implements GiteaClient {
  readonly #http: AxiosInstance;

  constructor(giteaBaseUrl: string, options: HttpGiteaClientOptions) {
    this.#http = axios.create({
      baseURL: `${normalizeBaseUrl(giteaBaseUrl)}/api/v1`,
      headers: {
        Accept: 'application/json',
        Authorization: `token ${options.authToken}`,
      },
      timeout: options.timeoutMs ?? 30_000,
    });
  }

  async repositoryExists(owner: string, name: string): Promise<boolean> {
    const response = await this.#http.get(
      `/repos/${encodePathPart(owner)}/${encodePathPart(name)}`,
      {
        validateStatus: (status) => status === 200 || status === 404,
      }
    );

    return response.status === 200;
  }

  async organizationExists(owner: string): Promise<boolean> {
    const response = await this.#http.get(`/orgs/${encodePathPart(owner)}`, {
      validateStatus: (status) => status === 200 || status === 404,
    });

    return response.status === 200;
  }

  async createOrganization(options: {
    fullName: string;
    name: string;
    visibility: 'private';
  }): Promise<void> {
    await this.#http.post(
      '/orgs',
      {
        full_name: options.fullName,
        username: options.name,
        visibility: options.visibility,
      },
      {
        validateStatus: (status) => status === 201,
      }
    );
  }

  async createRepository(options: {
    description: string;
    name: string;
    owner: string;
    private: boolean;
  }): Promise<void> {
    await this.#http.post(
      `/orgs/${encodePathPart(options.owner)}/repos`,
      {
        auto_init: false,
        description: options.description,
        name: options.name,
        private: options.private,
      },
      {
        validateStatus: (status) => status === 201,
      }
    );
  }
}

async function provisionOrganization(
  owner: string,
  options: ProvisionGiteaRepositoriesOptions
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
      visibility: 'private',
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

  try {
    const exists = await options.client.repositoryExists(source.owner, source.repo);
    if (exists) {
      return {
        owner: source.owner,
        private: isPrivate,
        repository: source.repo,
        status: 'exists',
        targetUrl,
      };
    }

    await options.client.createRepository({
      description: `airgap-sync mirror for ${source.id}`,
      name: source.repo,
      owner: source.owner,
      private: isPrivate,
    });

    return {
      owner: source.owner,
      private: isPrivate,
      repository: source.repo,
      status: 'created',
      targetUrl,
    };
  } catch (error) {
    return {
      error: errorMessage(error),
      owner: source.owner,
      private: isPrivate,
      repository: source.repo,
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
    error: `Organization ${source.owner} could not be provisioned: ${organization.error ?? 'unknown error'}`,
    owner: source.owner,
    private: isPrivate,
    repository: source.repo,
    status: 'error',
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
        owner: source.owner,
        private: isPrivate,
        repository: source.repo,
        status: 'planned',
        targetUrl: gitSourceTargetUrl(source, options.giteaBaseUrl),
      });
    }
  } else {
    for (const owner of owners) {
      const action = await provisionOrganization(owner, options);
      organizationActions.push(action);
      organizationActionsByOwner.set(owner, action);
    }

    for (const source of options.manifest.sources) {
      const organization = organizationActionsByOwner.get(source.owner);
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
