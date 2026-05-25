import path from 'node:path';
import * as fs from './fs.js';
import type {
  GitRequirement,
  ParseRootSpecsResult,
  ProjectPackageManifest,
  RootPackageRequirement,
  UnsupportedRootPackageRequirement,
} from '../types.js';
import { parseDependencySpec, parseGitDependencySpec } from './specs.js';

const ignoredDirectoryNames = new Set([
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

const supportedLockfileNames = new Set([
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

export interface ReadManifestRequirementsOptions {
  includeDev?: boolean;
  includePeer?: boolean;
  skipManifestsCoveredByLockfiles?: boolean;
}

export interface ProjectManifestEntry {
  manifest: ProjectPackageManifest;
  path: string;
}

function dependencySpecsFromProjectManifest(
  manifest: ProjectPackageManifest,
  options: ReadManifestRequirementsOptions
): Record<string, string> {
  const peerDependencies =
    options.includePeer === true
      ? Object.fromEntries(
          Object.entries(manifest.peerDependencies ?? {}).filter(
            ([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true
          )
        )
      : {};

  return {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...(options.includeDev === true ? manifest.devDependencies : {}),
    ...peerDependencies,
  };
}

function manifestRequiredBy(entry: ProjectManifestEntry, rootDir: string): string {
  if (entry.manifest.name) {
    return entry.manifest.version
      ? `${entry.manifest.name}@${entry.manifest.version}`
      : entry.manifest.name;
  }

  const relativePath = path.relative(rootDir, entry.path) || path.basename(entry.path);
  return `manifest:${relativePath}`;
}

function isComponentPackageManifest(manifest: ProjectPackageManifest): boolean {
  const record = manifest as ProjectPackageManifest & Record<string, unknown>;
  const src = record.src;
  const hasComponentSourceList = Array.isArray(src) || typeof src === 'string';

  return (
    typeof record.repo === 'string' &&
    hasComponentSourceList &&
    record.scripts === undefined &&
    record.bin === undefined &&
    record.main === undefined &&
    record.module === undefined &&
    record.exports === undefined &&
    record.workspaces === undefined
  );
}

function isLocalDependency(
  name: string,
  specifier: string,
  localPackageNames: Set<string>
): boolean {
  return (
    localPackageNames.has(name) &&
    (specifier.startsWith('workspace:') ||
      specifier.startsWith('file:') ||
      specifier.startsWith('link:') ||
      specifier === '*')
  );
}

async function findProjectFiles(rootDir: string): Promise<{
  lockfileDirs: string[];
  packageJsonFiles: string[];
}> {
  const lockfileDirs = new Set<string>();
  const packageJsonFiles: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) {
          await walk(entryPath);
        }
        continue;
      }

      if (entry.isFile() && entry.name === 'package.json') {
        packageJsonFiles.push(entryPath);
        continue;
      }

      if (entry.isFile() && supportedLockfileNames.has(entry.name)) {
        lockfileDirs.add(dir);
      }
    }
  }

  await walk(rootDir);
  return { lockfileDirs: [...lockfileDirs].sort(), packageJsonFiles: packageJsonFiles.sort() };
}

function isCoveredByLockfile(file: string, lockfileDirs: string[]): boolean {
  const dir = path.dirname(file);
  return lockfileDirs.includes(dir);
}

async function manifestInputToFiles(
  manifestPath: string,
  options: ReadManifestRequirementsOptions
): Promise<{ files: string[]; rootDir: string }> {
  const absolutePath = path.resolve(manifestPath);
  const stat = await fs.stat(absolutePath);

  if (stat.isDirectory()) {
    const projectFiles = await findProjectFiles(absolutePath);
    return {
      files:
        options.skipManifestsCoveredByLockfiles === true
          ? projectFiles.packageJsonFiles.filter(
              (file) => !isCoveredByLockfile(file, projectFiles.lockfileDirs)
            )
          : projectFiles.packageJsonFiles,
      rootDir: absolutePath,
    };
  }

  const rootDir = path.dirname(absolutePath);
  const projectFiles = await findProjectFiles(rootDir);
  return {
    files: [...new Set([absolutePath, ...projectFiles.packageJsonFiles])]
      .filter(
        (file) =>
          options.skipManifestsCoveredByLockfiles !== true ||
          !isCoveredByLockfile(file, projectFiles.lockfileDirs)
      )
      .sort(),
    rootDir,
  };
}

export async function readManifestRequirements(
  manifestPath: string,
  options: ReadManifestRequirementsOptions = {}
): Promise<ParseRootSpecsResult> {
  const { files, rootDir } = await manifestInputToFiles(manifestPath, options);
  const entries: ProjectManifestEntry[] = [];

  for (const file of files) {
    entries.push({
      manifest: await fs.readJson<ProjectPackageManifest>(file),
      path: file,
    });
  }

  return parseManifestRequirementsFromEntries(entries, rootDir, options);
}

export function parseManifestRequirementsFromEntries(
  entries: ProjectManifestEntry[],
  rootDir: string,
  options: ReadManifestRequirementsOptions = {}
): ParseRootSpecsResult {
  const localPackageNames = new Set<string>();
  for (const entry of entries) {
    if (!isComponentPackageManifest(entry.manifest) && entry.manifest.name) {
      localPackageNames.add(entry.manifest.name);
    }
  }

  const gitRequirements: GitRequirement[] = [];
  const requirements: RootPackageRequirement[] = [];
  const unsupported: UnsupportedRootPackageRequirement[] = [];
  const seenRequirements = new Set<string>();

  for (const entry of entries) {
    if (isComponentPackageManifest(entry.manifest)) {
      continue;
    }

    const requiredBy = manifestRequiredBy(entry, rootDir);
    const dependencies = dependencySpecsFromProjectManifest(entry.manifest, options);

    for (const [name, specifier] of Object.entries(dependencies)) {
      if (isLocalDependency(name, specifier, localPackageNames)) {
        continue;
      }

      const parsed = parseDependencySpec(name, specifier, requiredBy);
      if ('reason' in parsed) {
        const gitRequirement = parseGitDependencySpec(name, specifier, requiredBy);
        if (gitRequirement) {
          gitRequirements.push(gitRequirement);
          continue;
        }
        unsupported.push(parsed);
        continue;
      }

      const requirementId = [
        parsed.requiredBy,
        parsed.name,
        parsed.specifier,
        parsed.type,
        parsed.alias ?? '',
      ].join('\0');
      if (!seenRequirements.has(requirementId)) {
        seenRequirements.add(requirementId);
        requirements.push(parsed);
      }
    }
  }

  return { gitRequirements, requirements, unsupported };
}
