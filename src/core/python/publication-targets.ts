import {
  mergeGiteaOwnerRequirements,
  resolveGiteaOwnerTarget,
  type GiteaOwnerRequirement,
  type GiteaOwnerTarget,
  type GiteaOwnerVisibility,
  type ResolvedGiteaOwner,
} from '../gitea-owners.js';

const defaultPythonPublicationOwner = 'airgap-packages';

export interface PythonPublicationProfile {
  genericOwner?: GiteaOwnerTarget;
  owner: GiteaOwnerTarget;
  pypiOwner?: GiteaOwnerTarget;
  publishEvidence?: boolean;
  visibility: GiteaOwnerVisibility;
}

export interface ResolvedPythonPublicationProfile {
  genericOwner: ResolvedGiteaOwner;
  ownerRequirements: GiteaOwnerRequirement[];
  pypiOwner: ResolvedGiteaOwner;
  publishEvidence: boolean;
  visibility: GiteaOwnerVisibility;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOwnerTarget(value: unknown, description: string): GiteaOwnerTarget {
  if (!isRecord(value)) {
    throw new Error(`${description} must be a Gitea owner target`);
  }
  if (value.strategy === 'authenticated-user') {
    return { strategy: 'authenticated-user' };
  }
  if (value.strategy !== 'fixed-owner') {
    throw new Error(`${description}.strategy must be authenticated-user or fixed-owner`);
  }
  if (value.kind !== 'organization' && value.kind !== 'user') {
    throw new Error(`${description}.kind must be organization or user`);
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error(`${description}.name must be a non-empty Gitea owner`);
  }
  return {
    kind: value.kind,
    name: value.name.trim(),
    strategy: 'fixed-owner',
  };
}

export function defaultPythonPublicationProfile(): PythonPublicationProfile {
  return {
    owner: {
      kind: 'organization',
      name: defaultPythonPublicationOwner,
      strategy: 'fixed-owner',
    },
    visibility: 'public',
  };
}

export function normalizePythonPublicationProfile(value: unknown): PythonPublicationProfile {
  if (!isRecord(value)) {
    throw new Error('python.publication must be an object');
  }
  const visibility =
    value.visibility === undefined || value.visibility === 'public'
      ? 'public'
      : value.visibility === 'private'
        ? 'private'
        : undefined;
  if (!visibility) {
    throw new Error('python.publication.visibility must be public or private');
  }
  return {
    ...(value.genericOwner !== undefined
      ? {
          genericOwner: normalizeOwnerTarget(value.genericOwner, 'python.publication.genericOwner'),
        }
      : {}),
    owner: normalizeOwnerTarget(value.owner, 'python.publication.owner'),
    ...(value.pypiOwner !== undefined
      ? { pypiOwner: normalizeOwnerTarget(value.pypiOwner, 'python.publication.pypiOwner') }
      : {}),
    ...(value.publishEvidence === true ? { publishEvidence: true } : {}),
    visibility,
  };
}

export function resolvePythonPublicationProfile(
  profile: PythonPublicationProfile,
  authenticatedUser: string | undefined
): ResolvedPythonPublicationProfile {
  const pypiOwner = resolveGiteaOwnerTarget(profile.pypiOwner ?? profile.owner, authenticatedUser);
  const genericOwner = resolveGiteaOwnerTarget(
    profile.genericOwner ?? profile.owner,
    authenticatedUser
  );
  const publishEvidence = profile.publishEvidence === true;
  return {
    genericOwner,
    ownerRequirements: mergeGiteaOwnerRequirements([
      {
        ...pypiOwner,
        purposes: ['pypi'],
        visibility: profile.visibility,
      },
      ...(publishEvidence
        ? [
            {
              ...genericOwner,
              purposes: ['generic' as const],
              visibility: profile.visibility,
            },
          ]
        : []),
    ]),
    pypiOwner,
    publishEvidence,
    visibility: profile.visibility,
  };
}
