import path from 'node:path';
import fs from 'fs-extra';
import type {
  GitRequirement,
  GitSource,
  GitSourcesManifest,
  SkippedGitRequirement,
} from '../types.js';

export interface GitSourcesOptions {
  createdAt?: string;
  mirrorRoot?: string;
}

interface SourceIdentity {
  host: string;
  id: string;
  owner: string;
  repo: string;
  sourceUrl: string;
}

function trimGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

function hostedSourceUrl(requirement: GitRequirement): string | undefined {
  const hosted = requirement.hosted;
  if (!hosted?.domain || !hosted.user || !hosted.project) {
    return undefined;
  }

  return `https://${hosted.domain}/${hosted.user}/${hosted.project}.git`;
}

function sourceUrl(requirement: GitRequirement): string | undefined {
  if (requirement.fetchSpec) {
    return requirement.fetchSpec.replace(/^git\+/, '');
  }

  return hostedSourceUrl(requirement);
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function identityFromHosted(requirement: GitRequirement, url: string): SourceIdentity | undefined {
  const hosted = requirement.hosted;
  if (!hosted?.domain || !hosted.user || !hosted.project) {
    return undefined;
  }

  const owner = safePathPart(hosted.user);
  const repo = safePathPart(trimGitSuffix(hosted.project));
  const host = hosted.domain.toLowerCase();

  return {
    host,
    id: `${host}/${owner}/${repo}`,
    owner,
    repo,
    sourceUrl: url,
  };
}

function identityFromUrl(url: string): SourceIdentity | undefined {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname
      .replace(/^\/+/, '')
      .split('/')
      .filter((part) => part.length > 0);
    if (parts.length < 2) {
      return undefined;
    }

    const owner = safePathPart(parts.at(-2) ?? '');
    const repo = safePathPart(trimGitSuffix(parts.at(-1) ?? ''));
    const host = parsed.hostname.toLowerCase();

    return {
      host,
      id: `${host}/${owner}/${repo}`,
      owner,
      repo,
      sourceUrl: url,
    };
  } catch {
    return undefined;
  }
}

function sourceIdentity(requirement: GitRequirement): SourceIdentity | undefined {
  const url = sourceUrl(requirement);
  if (!url) {
    return undefined;
  }

  return identityFromHosted(requirement, url) ?? identityFromUrl(url);
}

function requirementKey(requirement: GitRequirement): string {
  return [requirement.requiredBy, requirement.raw, requirement.rawSpec].join('\0');
}

function sortRequirements(requirements: GitRequirement[]): GitRequirement[] {
  return [...requirements].sort((left, right) => {
    const byRequiredBy = left.requiredBy.localeCompare(right.requiredBy);
    return byRequiredBy === 0 ? left.raw.localeCompare(right.raw) : byRequiredBy;
  });
}

function toLocalMirrorPath(identity: SourceIdentity, mirrorRoot: string): string {
  return path.posix.join(mirrorRoot, identity.host, identity.owner, `${identity.repo}.git`);
}

function mergeRequirement(source: GitSource, requirement: GitRequirement): void {
  if (!source.requirements.some((item) => requirementKey(item) === requirementKey(requirement))) {
    source.requirements.push(requirement);
  }
}

export function createGitSourcesManifest(
  requirements: GitRequirement[],
  options: GitSourcesOptions = {}
): GitSourcesManifest {
  const mirrorRoot = options.mirrorRoot ?? 'git-mirrors';
  const sources = new Map<string, GitSource>();
  const skipped: SkippedGitRequirement[] = [];

  for (const requirement of requirements) {
    const identity = sourceIdentity(requirement);
    if (!identity) {
      skipped.push({
        reason: 'Unable to infer a cloneable source identity',
        requirement,
      });
      continue;
    }

    const existing = sources.get(identity.id);
    if (existing) {
      mergeRequirement(existing, requirement);
      continue;
    }

    sources.set(identity.id, {
      host: identity.host,
      id: identity.id,
      localMirrorPath: toLocalMirrorPath(identity, mirrorRoot),
      owner: identity.owner,
      repo: identity.repo,
      requirements: [requirement],
      sourceUrl: identity.sourceUrl,
      ...(requirement.committish ? { committish: requirement.committish } : {}),
      ...(requirement.fetchSpec ? { fetchSpec: requirement.fetchSpec } : {}),
      ...(requirement.gitRange ? { gitRange: requirement.gitRange } : {}),
      ...(requirement.gitSubdir ? { gitSubdir: requirement.gitSubdir } : {}),
    });
  }

  return {
    schemaVersion: 1,
    createdAt: options.createdAt ?? new Date().toISOString(),
    sources: [...sources.values()]
      .map((source) => ({
        ...source,
        requirements: sortRequirements(source.requirements),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    skipped: skipped.sort((left, right) =>
      requirementKey(left.requirement).localeCompare(requirementKey(right.requirement))
    ),
  };
}

export async function writeGitSourcesManifest(
  bundleDir: string,
  manifest: GitSourcesManifest
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'git-sources.json'), manifest, { spaces: 2 });
}

export async function readGitSourcesManifest(bundleDir: string): Promise<GitSourcesManifest> {
  return (await fs.readJson(path.join(bundleDir, 'git-sources.json'))) as GitSourcesManifest;
}
