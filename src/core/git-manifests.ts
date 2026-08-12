import path from 'node:path';
import type { GitSource, ParseRootSpecsResult, ProjectPackageManifest } from '../types.js';
import {
  parseManifestRequirementsFromEntries,
  type ProjectManifestEntry,
  type ReadManifestRequirementsOptions,
} from './manifests.js';
import { safeDirectoryGitArgs } from './git-safe.js';
import { mapConcurrent } from './concurrency.js';
import {
  parseLockfileRequirementsFromContent,
  parsePnpmLockImporterDirectoriesFromContent,
} from './lockfiles.js';
import { parsePackageManagerRequirements } from './package-managers.js';
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
  'fixtures',
  'node_modules',
]);

export interface ReadGitSourceManifestRequirementsOptions extends ReadManifestRequirementsOptions {
  concurrency?: number;
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

function repositoryDirectory(base: string, relative: string): string {
  const directory = path.posix.join(base || '.', relative || '.');
  return directory === '.' ? '' : directory;
}

function manifestCoverageDirectories(lockfileEntries: { content: string; path: string }[]): {
  all: Set<string>;
  pnpm: Set<string>;
} {
  const all = new Set<string>();
  const pnpm = new Set<string>();
  for (const entry of lockfileEntries) {
    const lockfileDirectory = directoryName(entry.path);
    if (path.posix.basename(entry.path) !== 'pnpm-lock.yaml') {
      all.add(lockfileDirectory);
      continue;
    }
    const importers = parsePnpmLockImporterDirectoriesFromContent(entry.content);
    for (const importer of importers.length > 0 ? importers : ['']) {
      const directory = repositoryDirectory(lockfileDirectory, importer);
      all.add(directory);
      pnpm.add(directory);
    }
  }
  return { all, pnpm };
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
  const lockfileEntries = await mapConcurrent(
    lockfilePaths,
    options.concurrency,
    async (lockfilePath) => ({
      content: await readFileFromGit({
        filePath: lockfilePath,
        mirrorPath,
        revision,
        runner,
      }),
      path: lockfilePath,
    })
  );
  const coverageDirectories = manifestCoverageDirectories(lockfileEntries);
  const unlockedManifestPaths = manifestPaths.filter(
    (manifestPath) => !coverageDirectories.all.has(directoryName(manifestPath))
  );
  const manifestEntries = await mapConcurrent(
    manifestPaths,
    options.concurrency,
    async (manifestPath): Promise<ProjectManifestEntry> => ({
      manifest: await readPackageJsonFromGit({
        filePath: manifestPath,
        mirrorPath,
        revision,
        runner,
      }),
      path: manifestPath,
    })
  );
  const entriesByPath = new Map(manifestEntries.map((entry) => [entry.path, entry] as const));
  const entries = unlockedManifestPaths.map((manifestPath) => entriesByPath.get(manifestPath)!);
  const parsedManifests = parseManifestRequirementsFromEntries(entries, subdir, {
    includeDev: options.includeDev === true,
    includePeer: options.includePeer === true,
  });
  const parsedPackageManagers = parsePackageManagerRequirements(
    manifestPaths.map((manifestPath) => {
      const entry = entriesByPath.get(manifestPath)!;
      return {
        manifest: entry.manifest,
        pnpmLockfileCovered: coverageDirectories.pnpm.has(directoryName(manifestPath)),
        requiredBy:
          entry.manifest.name && entry.manifest.version
            ? `${entry.manifest.name}@${entry.manifest.version}`
            : (entry.manifest.name ?? `manifest:${manifestPath}`),
      };
    })
  );
  const parsedLockfiles = lockfileEntries.map(
    ({ content, path: lockfilePath }): ParseRootSpecsResult =>
      parseLockfileRequirementsFromContent(
        path.basename(lockfilePath),
        content,
        `lockfile:${path.posix.join(options.source.id, lockfilePath)}`
      )
  );
  return {
    gitRequirements: [
      ...parsedPackageManagers.gitRequirements,
      ...parsedManifests.gitRequirements,
      ...parsedLockfiles.flatMap((result) => result.gitRequirements),
    ],
    requirements: [
      ...parsedPackageManagers.requirements,
      ...parsedManifests.requirements,
      ...parsedLockfiles.flatMap((result) => result.requirements),
    ],
    unsupported: [
      ...parsedPackageManagers.unsupported,
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
