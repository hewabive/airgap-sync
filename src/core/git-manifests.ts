import path from 'node:path';
import type { GitSource, ParseRootSpecsResult, ProjectPackageManifest } from '../types.js';
import {
  parseManifestRequirementsFromEntries,
  type ProjectManifestEntry,
  type ReadManifestRequirementsOptions,
} from './manifests.js';
import { runGitOutputCommand, type GitOutputCommandRunner } from './repos.js';

const ignoredPathParts = new Set([
  '.git',
  '.hg',
  '.pnpm',
  '.svn',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

export interface ReadGitSourceManifestRequirementsOptions extends ReadManifestRequirementsOptions {
  mirrorPath: string;
  runner?: GitOutputCommandRunner;
  source: GitSource;
}

export interface GitSourceManifestRequirementsResult extends ParseRootSpecsResult {
  manifestPaths: string[];
  mirrorPath: string;
  revision: string;
  sourceId: string;
}

function revisionFromSource(source: GitSource): string {
  return source.committish ?? 'HEAD';
}

function normalizeGitSubdir(source: GitSource): string {
  return source.gitSubdir?.replace(/^\/+|\/+$/g, '') ?? '';
}

function isIgnoredPackageJsonPath(filePath: string): boolean {
  if (!filePath.endsWith('package.json')) {
    return true;
  }

  return filePath
    .split('/')
    .slice(0, -1)
    .some((part) => ignoredPathParts.has(part));
}

function isInsideSubdir(filePath: string, subdir: string): boolean {
  return (
    subdir.length === 0 ||
    filePath === `${subdir}/package.json` ||
    filePath.startsWith(`${subdir}/`)
  );
}

async function assertRevisionExists(options: {
  mirrorPath: string;
  revision: string;
  runner: GitOutputCommandRunner;
  source: GitSource;
}): Promise<void> {
  try {
    await options.runner({
      args: ['rev-parse', '--verify', `${options.revision}^{tree}`],
      cwd: options.mirrorPath,
    });
  } catch {
    throw new Error(
      `Git source ${options.source.id} does not contain requested revision ${options.revision}. ` +
        'The upstream repository may have rewritten history or removed the referenced object.'
    );
  }
}

async function listPackageJsonPaths(options: {
  mirrorPath: string;
  revision: string;
  runner: GitOutputCommandRunner;
  subdir: string;
}): Promise<string[]> {
  const result = await options.runner({
    args: ['ls-tree', '-r', '--name-only', options.revision],
    cwd: options.mirrorPath,
  });

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((filePath) => isInsideSubdir(filePath, options.subdir))
    .filter((filePath) => !isIgnoredPackageJsonPath(filePath))
    .sort();
}

async function readPackageJsonFromGit(options: {
  filePath: string;
  mirrorPath: string;
  revision: string;
  runner: GitOutputCommandRunner;
}): Promise<ProjectPackageManifest> {
  const result = await options.runner({
    args: ['show', `${options.revision}:${options.filePath}`],
    cwd: options.mirrorPath,
  });

  try {
    return JSON.parse(result.stdout) as ProjectPackageManifest;
  } catch (error) {
    throw new Error(
      `Invalid package.json at ${options.filePath} in ${options.mirrorPath}: ${(error as Error).message}`
    );
  }
}

export async function readGitSourceManifestRequirements(
  options: ReadGitSourceManifestRequirementsOptions
): Promise<GitSourceManifestRequirementsResult> {
  const mirrorPath = path.resolve(options.mirrorPath);
  const runner = options.runner ?? runGitOutputCommand;
  const revision = revisionFromSource(options.source);
  const subdir = normalizeGitSubdir(options.source);
  await assertRevisionExists({
    mirrorPath,
    revision,
    runner,
    source: options.source,
  });
  const manifestPaths = await listPackageJsonPaths({
    mirrorPath,
    revision,
    runner,
    subdir,
  });
  const entries: ProjectManifestEntry[] = [];

  for (const manifestPath of manifestPaths) {
    entries.push({
      manifest: await readPackageJsonFromGit({
        filePath: manifestPath,
        mirrorPath,
        revision,
        runner,
      }),
      path: manifestPath,
    });
  }

  return {
    ...parseManifestRequirementsFromEntries(entries, subdir, {
      includeDev: options.includeDev === true,
      includePeer: options.includePeer === true,
    }),
    manifestPaths,
    mirrorPath,
    revision,
    sourceId: options.source.id,
  };
}
