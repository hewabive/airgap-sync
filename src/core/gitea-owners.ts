export type GiteaOwnerKind = 'organization' | 'user';
export type GiteaOwnerPurpose = 'generic' | 'git' | 'npm' | 'pypi';
export type GiteaOwnerVisibility = 'private' | 'public';

export type GiteaOwnerTarget =
  | {
      strategy: 'authenticated-user';
    }
  | {
      kind: GiteaOwnerKind;
      name: string;
      strategy: 'fixed-owner';
    };

export interface ResolvedGiteaOwner {
  kind: GiteaOwnerKind;
  name: string;
}

export interface GiteaOwnerRequirement extends ResolvedGiteaOwner {
  purposes: GiteaOwnerPurpose[];
  visibility: GiteaOwnerVisibility;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeGiteaOwnerTarget(value: unknown, description: string): GiteaOwnerTarget {
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

const purposeOrder: Record<GiteaOwnerPurpose, number> = {
  git: 0,
  npm: 1,
  pypi: 2,
  generic: 3,
};

function normalizedOwner(value: string | undefined, description: string): string {
  const owner = value?.trim();
  if (!owner) {
    throw new Error(`${description} must be a non-empty Gitea owner`);
  }
  return owner;
}

function sortedPurposes(purposes: Iterable<GiteaOwnerPurpose>): GiteaOwnerPurpose[] {
  return [...new Set(purposes)].sort((left, right) => purposeOrder[left] - purposeOrder[right]);
}

export function resolveGiteaOwnerTarget(
  target: GiteaOwnerTarget,
  authenticatedUser: string | undefined
): ResolvedGiteaOwner {
  if (target.strategy === 'authenticated-user') {
    return {
      kind: 'user',
      name: normalizedOwner(authenticatedUser, 'Authenticated user'),
    };
  }

  const name = normalizedOwner(target.name, 'Fixed owner');
  if (target.kind === 'user') {
    const login = normalizedOwner(authenticatedUser, 'Authenticated user');
    if (name !== login) {
      throw new Error(`Fixed Gitea user ${name} does not match authenticated user ${login}`);
    }
  }
  return {
    kind: target.kind,
    name,
  };
}

export function mergeGiteaOwnerRequirements(
  requirements: GiteaOwnerRequirement[]
): GiteaOwnerRequirement[] {
  const merged = new Map<string, GiteaOwnerRequirement>();
  for (const requirement of requirements) {
    const name = normalizedOwner(requirement.name, 'Gitea owner');
    const key = name.toLowerCase();
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        kind: requirement.kind,
        name,
        purposes: sortedPurposes(requirement.purposes),
        visibility: requirement.visibility,
      });
      continue;
    }
    if (current.kind !== requirement.kind) {
      throw new Error(
        `Gitea owner ${name} is required as both ${current.kind} and ${requirement.kind}`
      );
    }
    current.purposes = sortedPurposes([...current.purposes, ...requirement.purposes]);
    if (requirement.visibility === 'public') {
      current.visibility = 'public';
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.kind.localeCompare(right.kind) ||
      left.visibility.localeCompare(right.visibility)
  );
}
