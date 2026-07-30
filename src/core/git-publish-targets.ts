import type { GitSource, GitSourcesManifest } from '../types.js';

export type GitOwnerStrategy = 'authenticated-user' | 'fixed-owner' | 'preserve';
export type GitPublishOwnerKind = 'organization' | 'user';

export interface ResolveGitPublishTargetsOptions {
  authenticatedUser?: string;
  fixedOwner?: string;
  fixedOwnerKind?: GitPublishOwnerKind;
  manifest: GitSourcesManifest;
  strategy?: GitOwnerStrategy;
}

function normalizedOwner(value: string | undefined, description: string): string {
  const owner = value?.trim();
  if (!owner) {
    throw new Error(`${description} must be a non-empty Gitea owner`);
  }
  return owner;
}

function remappedRepositoryName(source: GitSource): string {
  return `${source.owner}--${source.repo}`;
}

function publishTarget(source: GitSource): { key: string; path: string } {
  const owner = (source.publishOwner ?? source.owner).trim();
  const repo = (source.publishRepo ?? source.repo).trim();
  return {
    key: `${owner.toLowerCase()}\0${repo.toLowerCase()}`,
    path: `${owner}/${repo}`,
  };
}

export function assertUniqueGitPublishTargets(manifest: GitSourcesManifest): void {
  const destinations = new Map<string, { path: string; sourceIds: Set<string> }>();
  for (const source of manifest.sources) {
    const target = publishTarget(source);
    const destination = destinations.get(target.key) ?? {
      path: target.path,
      sourceIds: new Set<string>(),
    };
    destination.sourceIds.add(source.id);
    destinations.set(target.key, destination);
  }

  const collisions = [...destinations.values()]
    .filter((destination) => destination.sourceIds.size > 1)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (collisions.length === 0) {
    return;
  }

  const details = collisions
    .map((collision) => `${collision.path}: ${[...collision.sourceIds].sort().join(' and ')}`)
    .join('; ');
  throw new Error(
    `Git publish target collision: ${details}. Remove the obsolete source or choose a non-conflicting Git owner strategy before publishing.`
  );
}

function resolvedManifest(manifest: GitSourcesManifest, sources: GitSource[]): GitSourcesManifest {
  const resolved = { ...manifest, sources };
  assertUniqueGitPublishTargets(resolved);
  return resolved;
}

export function resolveGitPublishTargets(
  options: ResolveGitPublishTargetsOptions
): GitSourcesManifest {
  const strategy = options.strategy ?? 'preserve';
  if (strategy === 'preserve') {
    return resolvedManifest(
      options.manifest,
      options.manifest.sources.map((source) => ({
        ...source,
        publishOwner: source.owner,
        publishOwnerKind: 'organization',
        publishRepo: source.repo,
      }))
    );
  }

  const owner =
    strategy === 'authenticated-user'
      ? normalizedOwner(options.authenticatedUser, 'Authenticated user')
      : normalizedOwner(options.fixedOwner, 'Fixed owner');
  const ownerKind = strategy === 'authenticated-user' ? 'user' : options.fixedOwnerKind;
  if (ownerKind !== 'organization' && ownerKind !== 'user') {
    throw new Error('fixed-owner strategy requires fixedOwnerKind to be user or organization');
  }
  if (
    strategy === 'fixed-owner' &&
    ownerKind === 'user' &&
    normalizedOwner(options.authenticatedUser, 'Authenticated user') !== owner
  ) {
    const authenticatedUser = normalizedOwner(options.authenticatedUser, 'Authenticated user');
    throw new Error(
      `Fixed Gitea user ${owner} does not match authenticated user ${authenticatedUser}`
    );
  }

  const sources = options.manifest.sources.map((source) => ({
    ...source,
    publishOwner: owner,
    publishOwnerKind: ownerKind,
    publishRepo: remappedRepositoryName(source),
  }));

  return resolvedManifest(options.manifest, sources);
}
