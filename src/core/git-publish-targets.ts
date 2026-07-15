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

export function resolveGitPublishTargets(
  options: ResolveGitPublishTargetsOptions
): GitSourcesManifest {
  const strategy = options.strategy ?? 'preserve';
  if (strategy === 'preserve') {
    return {
      ...options.manifest,
      sources: options.manifest.sources.map((source) => ({
        ...source,
        publishOwner: source.owner,
        publishOwnerKind: 'organization',
        publishRepo: source.repo,
      })),
    };
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
  const names = new Map<string, string>();
  for (const source of sources) {
    const previous = names.get(source.publishRepo);
    if (previous && previous !== source.id) {
      throw new Error(
        `Git publish target collision for ${source.publishRepo}: ${previous} and ${source.id}`
      );
    }
    names.set(source.publishRepo, source.id);
  }

  return { ...options.manifest, sources };
}
