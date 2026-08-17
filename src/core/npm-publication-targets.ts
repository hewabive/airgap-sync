import {
  normalizeGiteaOwnerTarget,
  resolveGiteaOwnerTarget,
  type GiteaOwnerRequirement,
  type GiteaOwnerTarget,
  type GiteaOwnerVisibility,
  type ResolvedGiteaOwner,
} from './gitea-owners.js';
import { normalizeBaseUrl } from './git-targets.js';

export const defaultVerdaccioRegistryUrl = 'http://verdaccio.local:4873';
export const defaultGiteaNpmOwner = 'airgap-packages';

export type NpmRegistryTarget =
  | {
      type: 'verdaccio';
      url: string;
    }
  | {
      owner: GiteaOwnerTarget;
      type: 'gitea';
      visibility: GiteaOwnerVisibility;
    };

export type ResolvedNpmRegistryTarget =
  | {
      registryUrl: string;
      type: 'verdaccio';
    }
  | {
      owner: ResolvedGiteaOwner;
      ownerRequirement: GiteaOwnerRequirement;
      registryUrl: string;
      type: 'gitea';
      visibility: GiteaOwnerVisibility;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRegistryUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('npmRegistry.url must be a non-empty URL');
  }
  const normalized = value.trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('npmRegistry.url must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('npmRegistry.url must use http or https');
  }
  return normalized.replace(/\/+$/u, '');
}

export function defaultNpmRegistryTarget(): NpmRegistryTarget {
  return {
    type: 'verdaccio',
    url: defaultVerdaccioRegistryUrl,
  };
}

export function normalizeNpmRegistryTarget(value: unknown): NpmRegistryTarget {
  if (!isRecord(value)) {
    throw new Error('npmRegistry must be an object');
  }
  if (value.type === 'verdaccio') {
    return {
      type: 'verdaccio',
      url: normalizeRegistryUrl(value.url),
    };
  }
  if (value.type !== 'gitea') {
    throw new Error('npmRegistry.type must be verdaccio or gitea');
  }
  const visibility =
    value.visibility === undefined || value.visibility === 'public'
      ? 'public'
      : value.visibility === 'private'
        ? 'private'
        : undefined;
  if (!visibility) {
    throw new Error('npmRegistry.visibility must be public or private');
  }
  return {
    owner: normalizeGiteaOwnerTarget(value.owner, 'npmRegistry.owner'),
    type: 'gitea',
    visibility,
  };
}

export function giteaNpmRegistryUrl(giteaBaseUrl: string, owner: string): string {
  return `${normalizeBaseUrl(giteaBaseUrl)}/api/packages/${encodeURIComponent(owner)}/npm/`;
}

export function isGiteaNpmRegistryUrl(registryUrl: string): boolean {
  try {
    return /^\/api\/packages\/[^/]+\/npm\/?$/u.test(new URL(registryUrl).pathname);
  } catch {
    return false;
  }
}

export function resolveNpmRegistryTarget(
  target: NpmRegistryTarget,
  options: {
    authenticatedUser?: string;
    giteaBaseUrl?: string;
  }
): ResolvedNpmRegistryTarget {
  if (target.type === 'verdaccio') {
    return {
      registryUrl: target.url,
      type: 'verdaccio',
    };
  }
  if (!options.giteaBaseUrl) {
    throw new Error('Gitea npm registry requires giteaUrl');
  }
  const owner = resolveGiteaOwnerTarget(target.owner, options.authenticatedUser);
  return {
    owner,
    ownerRequirement: {
      ...owner,
      purposes: ['npm'],
      visibility: target.visibility,
    },
    registryUrl: giteaNpmRegistryUrl(options.giteaBaseUrl, owner.name),
    type: 'gitea',
    visibility: target.visibility,
  };
}
