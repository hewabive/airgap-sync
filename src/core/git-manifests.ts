import path from 'node:path';
import type { GitSource, ParseRootSpecsResult, ProjectPackageManifest } from '../types.js';
import {
  parseManifestRequirementsFromEntries,
  type ProjectManifestEntry,
  type ReadManifestRequirementsOptions,
} from './manifests.js';
import { safeDirectoryGitArgs } from './git-safe.js';
import { parseLockfileRequirementsFromContent } from './lockfiles.js';
import { runGitOutputCommand, type GitOutputCommandRunner } from './repos.js';

const supportedLockfileNames = new Set([
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

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
  lockfilePaths: string[];
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

function isIgnoredRepositoryPath(filePath: string): boolean {
  return filePath
    .split('/')
    .slice(0, -1)
    .some((part) => ignoredPathParts.has(part));
}

function isPackageJsonPath(filePath: string): boolean {
  return filePath.endsWith('package.json') && !isIgnoredRepositoryPath(filePath);
}

function isLockfilePath(filePath: string): boolean {
  return supportedLockfileNames.has(path.basename(filePath)) && !isIgnoredRepositoryPath(filePath);
}

function directoryName(filePath: string): string {
  const directory = path.posix.dirname(filePath);
  return directory === '.' ? '' : directory;
}

function isCoveredByLockfile(filePath: string, lockfilePaths: string[]): boolean {
  const directory = directoryName(filePath);
  return lockfilePaths.some((lockfilePath) => directory === directoryName(lockfilePath));
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
      args: safeDirectoryGitArgs(options.mirrorPath, [
        'rev-parse',
        '--verify',
        `${options.revision}^{tree}`,
      ]),
      cwd: options.mirrorPath,
    });
  } catch {
    throw new Error(
      `Git source ${options.source.id} does not contain requested revision ${options.revision}. ` +
        'The upstream repository may have rewritten history or removed the referenced object.'
    );
  }
}

async function listRepositoryFilePaths(options: {
  mirrorPath: string;
  revision: string;
  runner: GitOutputCommandRunner;
  subdir: string;
}): Promise<string[]> {
  const result = await options.runner({
    args: safeDirectoryGitArgs(options.mirrorPath, [
      'ls-tree',
      '-r',
      '--name-only',
      options.revision,
    ]),
    cwd: options.mirrorPath,
  });

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((filePath) => isInsideSubdir(filePath, options.subdir))
    .sort();
}

async function readFileFromGit(options: {
  filePath: string;
  mirrorPath: string;
  revision: string;
  runner: GitOutputCommandRunner;
}): Promise<string> {
  const result = await options.runner({
    args: safeDirectoryGitArgs(options.mirrorPath, [
      'show',
      `${options.revision}:${options.filePath}`,
    ]),
    cwd: options.mirrorPath,
  });

  return result.stdout;
}

async function readPackageJsonFromGit(options: {
  filePath: string;
  mirrorPath: string;
  revision: string;
  runner: GitOutputCommandRunner;
}): Promise<ProjectPackageManifest> {
  const content = await readFileFromGit(options);

  try {
    return JSON.parse(content) as ProjectPackageManifest;
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
  const repositoryPaths = await listRepositoryFilePaths({
    mirrorPath,
    revision,
    runner,
    subdir,
  });
  const manifestPaths = repositoryPaths.filter(isPackageJsonPath);
  const lockfilePaths = repositoryPaths.filter(isLockfilePath);
  const unlockedManifestPaths = manifestPaths.filter(
    (manifestPath) => !isCoveredByLockfile(manifestPath, lockfilePaths)
  );
  const entries: ProjectManifestEntry[] = [];

  for (const manifestPath of unlockedManifestPaths) {
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
  const parsedManifests = parseManifestRequirementsFromEntries(entries, subdir, {
    includeDev: options.includeDev === true,
    includePeer: options.includePeer === true,
  });
  const parsedLockfiles: ParseRootSpecsResult[] = [];
  for (const lockfilePath of lockfilePaths) {
    parsedLockfiles.push(
      parseLockfileRequirementsFromContent(
        path.basename(lockfilePath),
        await readFileFromGit({
          filePath: lockfilePath,
          mirrorPath,
          revision,
          runner,
        }),
        `lockfile:${lockfilePath}`
      )
    );
  }

  return {
    gitRequirements: [
      ...parsedManifests.gitRequirements,
      ...parsedLockfiles.flatMap((result) => result.gitRequirements),
    ],
    requirements: [
      ...parsedManifests.requirements,
      ...parsedLockfiles.flatMap((result) => result.requirements),
    ],
    unsupported: [
      ...parsedManifests.unsupported,
      ...parsedLockfiles.flatMap((result) => result.unsupported),
    ],
    lockfilePaths,
    manifestPaths: unlockedManifestPaths,
    mirrorPath,
    revision,
    sourceId: options.source.id,
  };
}
