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
import { assertUniqueGitPublishTargets } from './git-publish-targets.js';
import { mapConcurrent } from './concurrency.js';
import {
  mergeGiteaOwnerRequirements,
  type GiteaOwnerKind,
  type GiteaOwnerPurpose,
  type GiteaOwnerRequirement,
  type GiteaOwnerVisibility,
} from './gitea-owners.js';

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
  migrateRepository?(options: {
    authPassword?: string;
    authUsername?: string;
    cloneUrl: string;
    description: string;
    name: string;
    owner: string;
    private: boolean;
  }): Promise<void>;
  organizationExists(owner: string): Promise<boolean>;
  repositoryExists(owner: string, name: string): Promise<boolean>;
  setRepositoryDefaultBranch?(options: {
    branch: string;
    name: string;
    owner: string;
  }): Promise<void>;
}

interface GiteaCurrentUser {
  login?: unknown;
  username?: unknown;
}

export interface HttpGiteaClientOptions {
  authToken: string;
  migrationTimeoutMs?: number;
  timeoutMs?: number;
}

export interface GiteaRepositoryMigrationSource {
  cloneUrl(source: GitSource): string;
  credentials?: {
    password: string;
    username: string;
  };
}

export interface ProvisionGiteaRepositoriesOptions {
  client: GiteaClient;
  concurrency?: number;
  dryRun?: boolean;
  giteaBaseUrl: string;
  generatedAt?: string;
  manifest: GitSourcesManifest;
  migrationSource?: GiteaRepositoryMigrationSource;
  onProgress?: (event: GiteaRepositoryProvisionProgressEvent) => void;
  ownerRequirements?: GiteaOwnerRequirement[];
  private?: boolean;
}

export interface GiteaRepositoryProvisionProgressEvent {
  action: GiteaRepositoryActionResult;
  current: number;
  total: number;
}

export interface AssumeGiteaRepositoriesExistOptions {
  generatedAt?: string;
  giteaBaseUrl: string;
  manifest: GitSourcesManifest;
  private?: boolean;
}

export type GiteaOwnerProvisionStatus = 'planned' | 'exists' | 'created' | 'error';

export interface GiteaOwnerProvisionAction {
  error?: string;
  kind: GiteaOwnerKind;
  name: string;
  purposes: GiteaOwnerPurpose[];
  status: GiteaOwnerProvisionStatus;
  visibility: GiteaOwnerVisibility;
}

export interface GiteaOwnerProvisionReport {
  actions: GiteaOwnerProvisionAction[];
  created: number;
  dryRun: boolean;
  errors: GiteaOwnerProvisionAction[];
  exists: number;
  generatedAt: string;
  planned: number;
}

export interface ProvisionGiteaOwnersOptions {
  authenticatedUser?: string;
  client: GiteaClient;
  concurrency?: number;
  dryRun?: boolean;
  generatedAt?: string;
  requirements: GiteaOwnerRequirement[];
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

function gitOwnerRequirements(
  manifest: GitSourcesManifest,
  visibility: GiteaOwnerVisibility
): GiteaOwnerRequirement[] {
  return uniqueOwners(manifest).map((name) => ({
    kind: 'organization',
    name,
    purposes: ['git'],
    visibility,
  }));
}

export class HttpGiteaClient implements GiteaClient {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #migrationTimeoutMs: number;
  readonly #timeoutMs: number;

  constructor(giteaBaseUrl: string, options: HttpGiteaClientOptions) {
    this.#baseUrl = `${normalizeBaseUrl(giteaBaseUrl)}/api/v1`;
    this.#headers = {
      Accept: 'application/json',
      Authorization: `token ${options.authToken}`,
    };
    this.#migrationTimeoutMs = options.migrationTimeoutMs ?? 660_000;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async #request(
    path: string,
    options: {
      body?: unknown;
      method: 'GET' | 'PATCH' | 'POST';
      timeoutMs?: number;
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
      signal: AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs),
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
      options.ownerKind === 'user' ? '/user/repos' : `/orgs/${encodePathPart(options.owner)}/repos`,
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

  async migrateRepository(options: {
    authPassword?: string;
    authUsername?: string;
    cloneUrl: string;
    description: string;
    name: string;
    owner: string;
    private: boolean;
  }): Promise<void> {
    await this.#request('/repos/migrate', {
      body: {
        ...(options.authPassword ? { auth_password: options.authPassword } : {}),
        ...(options.authUsername ? { auth_username: options.authUsername } : {}),
        clone_addr: options.cloneUrl,
        description: options.description,
        issues: false,
        labels: false,
        lfs: false,
        milestones: false,
        mirror: false,
        private: options.private,
        pull_requests: false,
        releases: false,
        repo_name: options.name,
        repo_owner: options.owner,
        service: 'git',
        wiki: false,
      },
      method: 'POST',
      timeoutMs: this.#migrationTimeoutMs,
      validStatuses: new Set([201]),
    });
  }

  async setRepositoryDefaultBranch(options: {
    branch: string;
    name: string;
    owner: string;
  }): Promise<void> {
    await this.#request(`/repos/${encodePathPart(options.owner)}/${encodePathPart(options.name)}`, {
      body: { default_branch: options.branch },
      method: 'PATCH',
      validStatuses: new Set([200]),
    });
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

export async function provisionGiteaOwners(
  options: ProvisionGiteaOwnersOptions
): Promise<GiteaOwnerProvisionReport> {
  const requirements = mergeGiteaOwnerRequirements(options.requirements);
  const actions = await mapConcurrent(
    requirements,
    options.concurrency ?? 1,
    async (requirement) => {
      if (requirement.kind === 'user') {
        if (!options.authenticatedUser || requirement.name !== options.authenticatedUser) {
          return {
            ...requirement,
            error: `Gitea user owner ${requirement.name} must match the authenticated user`,
            status: 'error' as const,
          };
        }
        return {
          ...requirement,
          status: 'exists' as const,
        };
      }
      if (options.dryRun === true) {
        return {
          ...requirement,
          status: 'planned' as const,
        };
      }
      try {
        if (await options.client.organizationExists(requirement.name)) {
          return {
            ...requirement,
            status: 'exists' as const,
          };
        }
        await options.client.createOrganization({
          fullName: `airgap-sync managed owner for ${requirement.purposes.join(', ')}`,
          name: requirement.name,
          visibility: requirement.visibility,
        });
        return {
          ...requirement,
          status: 'created' as const,
        };
      } catch (error) {
        return {
          ...requirement,
          error: errorMessage(error),
          status: 'error' as const,
        };
      }
    }
  );
  return {
    actions,
    created: actions.filter((action) => action.status === 'created').length,
    dryRun: options.dryRun === true,
    errors: actions.filter((action) => action.status === 'error'),
    exists: actions.filter((action) => action.status === 'exists').length,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    planned: actions.filter((action) => action.status === 'planned').length,
  };
}

async function provisionRepository(
  source: GitSource,
  options: ProvisionGiteaRepositoriesOptions,
  isPrivate: boolean
): Promise<GiteaRepositoryActionResult> {
  const targetUrl = gitSourceTargetUrl(source, options.giteaBaseUrl);
  const owner = gitSourcePublishOwner(source);
  const repo = gitSourcePublishRepo(source);
  const description = `airgap-sync mirror for ${source.id}`;
  let migrationError: string | undefined;

  try {
    if (options.migrationSource && options.client.migrateRepository) {
      try {
        const credentials = options.migrationSource.credentials;
        await options.client.migrateRepository({
          ...(credentials
            ? { authPassword: credentials.password, authUsername: credentials.username }
            : {}),
          cloneUrl: options.migrationSource.cloneUrl(source),
          description,
          name: repo,
          owner,
          private: isPrivate,
        });
        return {
          owner,
          private: isPrivate,
          repository: repo,
          status: 'migrated',
          targetUrl,
        };
      } catch (error) {
        migrationError = errorMessage(error);
        if (await options.client.repositoryExists(owner, repo)) {
          return {
            migrationError,
            owner,
            private: isPrivate,
            repository: repo,
            status: 'created',
            targetUrl,
          };
        }
      }
    }

    await options.client.createRepository({
      description,
      name: repo,
      owner,
      ownerKind: gitSourcePublishOwnerKind(source),
      private: isPrivate,
    });

    return {
      ...(migrationError ? { migrationError } : {}),
      owner,
      private: isPrivate,
      repository: repo,
      status: 'created',
      targetUrl,
    };
  } catch (error) {
    return {
      error: errorMessage(error),
      ...(migrationError ? { migrationError } : {}),
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
  assertUniqueGitPublishTargets(options.manifest);
  const isPrivate = options.private ?? true;
  const actions: GiteaRepositoryActionResult[] = [];
  const organizationActions: GiteaOrganizationActionResult[] = [];
  const organizationActionsByOwner = new Map<string, GiteaOrganizationActionResult>();

  if (options.dryRun === true) {
    const ownerReport = await provisionGiteaOwners({
      client: options.client,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      dryRun: true,
      ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
      requirements: [
        ...gitOwnerRequirements(options.manifest, isPrivate ? 'private' : 'public'),
        ...(options.ownerRequirements ?? []),
      ],
    });
    for (const ownerAction of ownerReport.actions) {
      const action: GiteaOrganizationActionResult = {
        ...(ownerAction.error ? { error: ownerAction.error } : {}),
        owner: ownerAction.name,
        status: ownerAction.status,
      };
      organizationActions.push(action);
      organizationActionsByOwner.set(ownerAction.name, action);
    }

    for (const source of options.manifest.sources) {
      const action: GiteaRepositoryActionResult = {
        owner: gitSourcePublishOwner(source),
        private: isPrivate,
        repository: gitSourcePublishRepo(source),
        status: 'planned',
        targetUrl: gitSourceTargetUrl(source, options.giteaBaseUrl),
      };
      actions.push(action);
      options.onProgress?.({
        action,
        current: actions.length,
        total: options.manifest.sources.length,
      });
    }
  } else {
    const missingSources: GitSource[] = [];
    const sourceChecks = await mapConcurrent(
      options.manifest.sources,
      options.concurrency ?? 1,
      async (source) => {
        try {
          return {
            exists: await options.client.repositoryExists(
              gitSourcePublishOwner(source),
              gitSourcePublishRepo(source)
            ),
            source,
          };
        } catch (error) {
          return { error: errorMessage(error), exists: false, source };
        }
      }
    );
    for (const check of sourceChecks) {
      const { source } = check;
      if (check.error) {
        const action: GiteaRepositoryActionResult = {
          error: check.error,
          owner: gitSourcePublishOwner(source),
          private: isPrivate,
          repository: gitSourcePublishRepo(source),
          status: 'error',
          targetUrl: gitSourceTargetUrl(source, options.giteaBaseUrl),
        };
        actions.push(action);
        options.onProgress?.({
          action,
          current: actions.length,
          total: options.manifest.sources.length,
        });
        continue;
      }
      if (!check.exists) {
        missingSources.push(source);
        continue;
      }
      const action = existingRepositoryAction(source, options, isPrivate);
      actions.push(action);
      options.onProgress?.({
        action,
        current: actions.length,
        total: options.manifest.sources.length,
      });
      const owner = gitSourcePublishOwner(source);
      if (
        gitSourcePublishOwnerKind(source) === 'organization' &&
        !organizationActionsByOwner.has(owner)
      ) {
        const organizationAction: GiteaOrganizationActionResult = {
          owner,
          status: 'exists',
        };
        organizationActions.push(organizationAction);
        organizationActionsByOwner.set(owner, organizationAction);
      }
    }

    const missingManifest = { ...options.manifest, sources: missingSources };
    const ownerReport = await provisionGiteaOwners({
      client: options.client,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
      requirements: [
        ...gitOwnerRequirements(missingManifest, isPrivate ? 'private' : 'public'),
        ...(options.ownerRequirements ?? []),
      ],
    });
    for (const ownerAction of ownerReport.actions) {
      if (organizationActionsByOwner.has(ownerAction.name)) {
        continue;
      }
      const action: GiteaOrganizationActionResult = {
        ...(ownerAction.error ? { error: ownerAction.error } : {}),
        owner: ownerAction.name,
        status: ownerAction.status,
      };
      organizationActions.push(action);
      organizationActionsByOwner.set(ownerAction.name, action);
    }

    let completed = actions.length;
    actions.push(
      ...(await mapConcurrent(missingSources, options.concurrency ?? 1, async (source) => {
        const organization = organizationActionsByOwner.get(gitSourcePublishOwner(source));
        const action =
          organization?.status === 'error'
            ? repositoryBlockedByOrganizationError(source, organization, options, isPrivate)
            : await provisionRepository(source, options, isPrivate);
        completed += 1;
        options.onProgress?.({
          action,
          current: completed,
          total: options.manifest.sources.length,
        });
        return action;
      }))
    );
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
    migrated: actions.filter((action) => action.status === 'migrated').length,
    migrationFallbacks: actions.filter((action) => action.migrationError !== undefined),
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
  assertUniqueGitPublishTargets(options.manifest);
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
    migrated: 0,
    migrationFallbacks: [],
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
