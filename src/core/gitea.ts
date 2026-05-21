import axios, { type AxiosInstance } from 'axios';
import type {
  GiteaOwnerType,
  GiteaRepositoryActionResult,
  GiteaRepositoryProvisionReport,
  GitMirrorPlan,
  GitMirrorRepositoryPlan,
} from '../types.js';

export interface GiteaClient {
  createRepository(options: {
    description: string;
    name: string;
    owner: string;
    ownerType: GiteaOwnerType;
    private: boolean;
  }): Promise<void>;
  repositoryExists(owner: string, name: string): Promise<boolean>;
}

export interface HttpGiteaClientOptions {
  authToken: string;
  timeoutMs?: number;
}

export interface ProvisionGiteaRepositoriesOptions {
  client: GiteaClient;
  dryRun?: boolean;
  generatedAt?: string;
  ownerType: GiteaOwnerType;
  plan: GitMirrorPlan;
  private?: boolean;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
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

  async createRepository(options: {
    description: string;
    name: string;
    owner: string;
    ownerType: GiteaOwnerType;
    private: boolean;
  }): Promise<void> {
    const endpoint =
      options.ownerType === 'org' ? `/orgs/${encodePathPart(options.owner)}/repos` : '/user/repos';

    await this.#http.post(
      endpoint,
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

async function provisionRepository(
  repository: GitMirrorRepositoryPlan,
  options: ProvisionGiteaRepositoriesOptions,
  isPrivate: boolean
): Promise<GiteaRepositoryActionResult> {
  try {
    const exists = await options.client.repositoryExists(options.plan.owner, repository.repository);
    if (exists) {
      return {
        private: isPrivate,
        repository: repository.repository,
        status: 'exists',
        targetUrl: repository.targetUrl,
      };
    }

    await options.client.createRepository({
      description: `airgap-sync mirror for ${repository.id}`,
      name: repository.repository,
      owner: options.plan.owner,
      ownerType: options.ownerType,
      private: isPrivate,
    });

    return {
      private: isPrivate,
      repository: repository.repository,
      status: 'created',
      targetUrl: repository.targetUrl,
    };
  } catch (error) {
    return {
      error: errorMessage(error),
      private: isPrivate,
      repository: repository.repository,
      status: 'error',
      targetUrl: repository.targetUrl,
    };
  }
}

export async function provisionGiteaRepositories(
  options: ProvisionGiteaRepositoriesOptions
): Promise<GiteaRepositoryProvisionReport> {
  const isPrivate = options.private ?? true;
  const actions: GiteaRepositoryActionResult[] = [];

  if (options.dryRun === true) {
    for (const repository of options.plan.repositories) {
      actions.push({
        private: isPrivate,
        repository: repository.repository,
        status: 'planned',
        targetUrl: repository.targetUrl,
      });
    }
  } else {
    for (const repository of options.plan.repositories) {
      actions.push(await provisionRepository(repository, options, isPrivate));
    }
  }

  const errors = actions.filter((action) => action.status === 'error');

  return {
    created: actions.filter((action) => action.status === 'created').length,
    dryRun: options.dryRun === true,
    errors,
    exists: actions.filter((action) => action.status === 'exists').length,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    giteaBaseUrl: options.plan.giteaBaseUrl,
    owner: options.plan.owner,
    ownerType: options.ownerType,
    planned: actions.filter((action) => action.status === 'planned').length,
    private: isPrivate,
    totalRepositories: actions.length,
  };
}
