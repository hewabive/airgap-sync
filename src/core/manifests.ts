import path from 'node:path';
import fs from 'fs-extra';
import type {
  ParseRootSpecsResult,
  ProjectPackageManifest,
  RootPackageRequirement,
  UnsupportedRootPackageRequirement,
} from '../types.js';
import { parseDependencySpec } from './specs.js';

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

export interface ReadManifestRequirementsOptions {
  includeDev?: boolean;
  includePeer?: boolean;
}

interface ProjectManifestEntry {
  manifest: ProjectPackageManifest;
  path: string;
}

function dependencySpecsFromProjectManifest(
  manifest: ProjectPackageManifest,
  options: ReadManifestRequirementsOptions
): Record<string, string> {
  return {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...(options.includeDev === true ? manifest.devDependencies : {}),
    ...(options.includePeer === true ? manifest.peerDependencies : {}),
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

async function findPackageJsonFiles(rootDir: string): Promise<string[]> {
  const found: string[] = [];

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
        found.push(entryPath);
      }
    }
  }

  await walk(rootDir);
  return found.sort();
}

async function manifestInputToFiles(
  manifestPath: string
): Promise<{ files: string[]; rootDir: string }> {
  const absolutePath = path.resolve(manifestPath);
  const stat = await fs.stat(absolutePath);

  if (stat.isDirectory()) {
    return {
      files: await findPackageJsonFiles(absolutePath),
      rootDir: absolutePath,
    };
  }

  const rootDir = path.dirname(absolutePath);
  const nestedFiles = await findPackageJsonFiles(rootDir);
  return {
    files: [...new Set([absolutePath, ...nestedFiles])].sort(),
    rootDir,
  };
}

export async function readManifestRequirements(
  manifestPath: string,
  options: ReadManifestRequirementsOptions = {}
): Promise<ParseRootSpecsResult> {
  const { files, rootDir } = await manifestInputToFiles(manifestPath);
  const entries: ProjectManifestEntry[] = [];

  for (const file of files) {
    entries.push({
      manifest: (await fs.readJson(file)) as ProjectPackageManifest,
      path: file,
    });
  }

  const localPackageNames = new Set<string>();
  for (const entry of entries) {
    if (entry.manifest.name) {
      localPackageNames.add(entry.manifest.name);
    }
  }

  const requirements: RootPackageRequirement[] = [];
  const unsupported: UnsupportedRootPackageRequirement[] = [];
  const seenRequirements = new Set<string>();

  for (const entry of entries) {
    const requiredBy = manifestRequiredBy(entry, rootDir);
    const dependencies = dependencySpecsFromProjectManifest(entry.manifest, options);

    for (const [name, specifier] of Object.entries(dependencies)) {
      if (isLocalDependency(name, specifier, localPackageNames)) {
        continue;
      }

      const parsed = parseDependencySpec(name, specifier, requiredBy);
      if ('reason' in parsed) {
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

  return { requirements, unsupported };
}
