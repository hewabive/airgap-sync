import path from 'node:path';
import * as fs from './fs.js';
import semver from 'semver';
import YAML from 'yaml';
import type { GitRequirement, ParseRootSpecsResult, RootPackageRequirement } from '../types.js';
import { parseGitDependencySpec } from './specs.js';

const supportedLockfileNames = new Set([
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

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

interface PackageLockPackageEntry {
  link?: boolean;
  optional?: boolean;
  peer?: boolean;
  resolved?: string;
  version?: string;
}

interface PackageLockDependencyEntry {
  dependencies?: Record<string, PackageLockDependencyEntry>;
  resolved?: string;
  version?: string;
}

interface PackageLockDocument {
  dependencies?: Record<string, PackageLockDependencyEntry>;
  importers?: Record<string, PnpmImporterEntry>;
  packages?: Record<string, PackageLockPackageEntry>;
  snapshots?: Record<string, unknown>;
}

interface PnpmImporterDependencyEntry {
  specifier?: string;
  version?: string;
}

interface PnpmImporterEntry {
  dependencies?: Record<string, PnpmImporterDependencyEntry | string>;
  devDependencies?: Record<string, PnpmImporterDependencyEntry | string>;
  optionalDependencies?: Record<string, PnpmImporterDependencyEntry | string>;
}

function registryRequirement(
  name: string,
  version: string,
  requiredBy: string
): RootPackageRequirement | undefined {
  if (!name || !semver.valid(version)) {
    return undefined;
  }

  return {
    name,
    raw: `${name}@${version}`,
    requiredBy,
    specifier: version,
    type: 'version',
  };
}

function parsePackageKey(key: string): { name: string; version: string } | undefined {
  const withoutPeerSuffix = key.replace(/^\//, '').split('(')[0] ?? '';
  const versionSeparator = withoutPeerSuffix.lastIndexOf('@');

  if (versionSeparator <= 0) {
    return undefined;
  }

  const name = withoutPeerSuffix.slice(0, versionSeparator);
  const version = withoutPeerSuffix.slice(versionSeparator + 1);

  return semver.valid(version) ? { name, version } : undefined;
}

function requirementFromPackageKey(
  key: string,
  requiredBy: string
): RootPackageRequirement | undefined {
  const parsed = parsePackageKey(key);
  return parsed ? registryRequirement(parsed.name, parsed.version, requiredBy) : undefined;
}

function splitNameAndSpecifier(value: string): { name: string; specifier: string } | undefined {
  const normalized = value.replace(/^\//, '').split('(')[0] ?? '';

  if (normalized.startsWith('@')) {
    const slashIndex = normalized.indexOf('/');
    const versionSeparator = slashIndex === -1 ? -1 : normalized.indexOf('@', slashIndex + 1);
    return versionSeparator === -1
      ? undefined
      : {
          name: normalized.slice(0, versionSeparator),
          specifier: normalized.slice(versionSeparator + 1),
        };
  }

  const versionSeparator = normalized.indexOf('@');
  return versionSeparator <= 0
    ? undefined
    : {
        name: normalized.slice(0, versionSeparator),
        specifier: normalized.slice(versionSeparator + 1),
      };
}

function gitRequirementFromPackageKey(
  key: string
): { name: string; specifier: string } | undefined {
  const parsed = splitNameAndSpecifier(key);
  return parsed && isGitSpecifier(parsed.specifier) ? parsed : undefined;
}

function packageNameFromNodeModulesPath(lockPath: string): string | undefined {
  const marker = 'node_modules/';
  const markerIndex = lockPath.lastIndexOf(marker);

  if (markerIndex === -1) {
    return undefined;
  }

  return lockPath.slice(markerIndex + marker.length);
}

function isNonRegistryResolved(resolved: string | undefined): boolean {
  return Boolean(
    resolved &&
    (resolved.startsWith('file:') || resolved.startsWith('link:') || isGitSpecifier(resolved))
  );
}

function isGitSpecifier(specifier: string | undefined): specifier is string {
  return Boolean(
    specifier &&
    (specifier.startsWith('git+') ||
      specifier.startsWith('git:') ||
      specifier.startsWith('github:') ||
      specifier.startsWith('gitlab:') ||
      specifier.startsWith('bitbucket:') ||
      specifier.startsWith('gist:') ||
      specifier.startsWith('ssh://git@'))
  );
}

function gitSpecifierFromValues(...values: (string | undefined)[]): string | undefined {
  return values.find(isGitSpecifier);
}

function addRequirement(
  requirements: RootPackageRequirement[],
  seen: Set<string>,
  requirement: RootPackageRequirement | undefined
): void {
  if (!requirement) {
    return;
  }

  const id = `${requirement.name}\0${requirement.specifier}`;
  if (seen.has(id)) {
    return;
  }

  seen.add(id);
  requirements.push(requirement);
}

function addGitRequirement(
  gitRequirements: GitRequirement[],
  seen: Set<string>,
  name: string | undefined,
  specifier: string | undefined,
  requiredBy: string
): void {
  if (!name || !specifier) {
    return;
  }

  const requirement = parseGitDependencySpec(name, specifier, requiredBy);
  if (!requirement) {
    return;
  }

  const id = `${requirement.requiredBy}\0${requirement.raw}\0${requirement.rawSpec}`;
  if (seen.has(id)) {
    return;
  }

  seen.add(id);
  gitRequirements.push(requirement);
}

function sortGitRequirements(requirements: GitRequirement[]): GitRequirement[] {
  return requirements.sort((left, right) => {
    const byRequiredBy = left.requiredBy.localeCompare(right.requiredBy);
    return byRequiredBy === 0 ? left.raw.localeCompare(right.raw) : byRequiredBy;
  });
}

export function parsePnpmLockRequirementsFromContent(
  content: string,
  requiredBy: string
): ParseRootSpecsResult {
  const parsed = YAML.parse(content) as PackageLockDocument | null;
  const packageKeys = new Set<string>();
  const requirements: RootPackageRequirement[] = [];
  const seen = new Set<string>();
  const gitRequirements: GitRequirement[] = [];
  const seenGit = new Set<string>();

  function visitDependencyMap(
    dependencies: Record<string, PnpmImporterDependencyEntry | string> = {}
  ): void {
    for (const [name, entry] of Object.entries(dependencies)) {
      const specifier =
        typeof entry === 'string'
          ? gitSpecifierFromValues(entry)
          : gitSpecifierFromValues(entry.specifier, entry.version);
      addGitRequirement(gitRequirements, seenGit, name, specifier, requiredBy);
    }
  }

  for (const importer of Object.values(parsed?.importers ?? {})) {
    visitDependencyMap(importer.dependencies);
    visitDependencyMap(importer.devDependencies);
    visitDependencyMap(importer.optionalDependencies);
  }

  for (const section of [parsed?.packages, parsed?.snapshots]) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      continue;
    }

    for (const key of Object.keys(section)) {
      packageKeys.add(key);
    }
  }

  for (const key of packageKeys) {
    addRequirement(requirements, seen, requirementFromPackageKey(key, requiredBy));

    const parsedGit = gitRequirementFromPackageKey(key);
    addGitRequirement(gitRequirements, seenGit, parsedGit?.name, parsedGit?.specifier, requiredBy);
  }

  requirements.sort((left, right) => left.raw.localeCompare(right.raw));
  return { gitRequirements: sortGitRequirements(gitRequirements), requirements, unsupported: [] };
}

export function parseNpmLockRequirementsFromContent(
  content: string,
  requiredBy: string
): ParseRootSpecsResult {
  const parsed = JSON.parse(content) as PackageLockDocument;
  const requirements: RootPackageRequirement[] = [];
  const seen = new Set<string>();
  const gitRequirements: GitRequirement[] = [];
  const seenGit = new Set<string>();

  for (const [lockPath, entry] of Object.entries(parsed.packages ?? {})) {
    if (!lockPath || entry.link === true) {
      continue;
    }

    const name = packageNameFromNodeModulesPath(lockPath);
    const registryName = packageNameFromResolvedTarball(entry.resolved) ?? name;
    addGitRequirement(
      gitRequirements,
      seenGit,
      name,
      gitSpecifierFromValues(entry.resolved, entry.version),
      requiredBy
    );

    if (isNonRegistryResolved(entry.resolved)) {
      continue;
    }

    if (registryName && entry.version && !(entry.peer === true && entry.optional === true)) {
      addRequirement(
        requirements,
        seen,
        registryRequirement(registryName, entry.version, requiredBy)
      );
    }
  }

  function visitDependencies(dependencies: Record<string, PackageLockDependencyEntry> = {}): void {
    for (const [name, entry] of Object.entries(dependencies)) {
      addGitRequirement(
        gitRequirements,
        seenGit,
        name,
        gitSpecifierFromValues(entry.resolved, entry.version),
        requiredBy
      );

      if (!isNonRegistryResolved(entry.resolved) && entry.version) {
        addRequirement(requirements, seen, registryRequirement(name, entry.version, requiredBy));
      }

      visitDependencies(entry.dependencies);
    }
  }

  visitDependencies(parsed.dependencies);
  requirements.sort((left, right) => left.raw.localeCompare(right.raw));
  return { gitRequirements: sortGitRequirements(gitRequirements), requirements, unsupported: [] };
}

function firstYarnSelector(descriptor: string): string {
  return (
    descriptor
      .split(',')
      .map((selector) => selector.trim())
      .find(Boolean) ?? ''
  );
}

function packageNameFromYarnDescriptor(descriptor: string): string | undefined {
  const selector = firstYarnSelector(descriptor).replace(/^"|"$/g, '');
  return splitNameAndSpecifier(selector)?.name;
}

function gitSpecifierFromYarnDescriptor(descriptor: string): string | undefined {
  const selector = firstYarnSelector(descriptor).replace(/^"|"$/g, '');
  const specifier = splitNameAndSpecifier(selector)?.specifier;
  return isGitSpecifier(specifier) ? specifier : undefined;
}

function packageNameFromYarnResolution(resolution: unknown): string | undefined {
  if (typeof resolution !== 'string') {
    return undefined;
  }

  const npmProtocolIndex = resolution.indexOf('@npm:');
  if (npmProtocolIndex === -1) {
    return undefined;
  }

  return resolution.slice(0, npmProtocolIndex);
}

function gitSpecifierFromYarnResolution(resolution: unknown): string | undefined {
  if (typeof resolution !== 'string') {
    return undefined;
  }

  const parsed = splitNameAndSpecifier(resolution);
  return parsed && isGitSpecifier(parsed.specifier) ? parsed.specifier : undefined;
}

function packageNameFromResolvedTarball(resolved: unknown): string | undefined {
  if (typeof resolved !== 'string' || !resolved.startsWith('http')) {
    return undefined;
  }

  try {
    const parsed = new URL(resolved);
    const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const packageDirectoryIndex = parts.indexOf('-');

    if (parts[0]?.startsWith('@') && parts[1] === '-') {
      return parts[0];
    }

    if (parts[0]?.startsWith('@') && parts[1] && parts[2] === '-') {
      return `${parts[0]}/${parts[1]}`;
    }

    if (packageDirectoryIndex === 1 && parts[0]) {
      return parts[0];
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseYarnClassicEntries(content: string): {
  descriptor: string;
  resolved?: string;
  version?: string;
}[] {
  const entries: { descriptor: string; resolved?: string; version?: string }[] = [];
  let current: { descriptor: string; resolved?: string; version?: string } | undefined;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) {
      continue;
    }

    if (!line.startsWith(' ') && line.endsWith(':')) {
      current = { descriptor: line.slice(0, -1).trim().replace(/^"|"$/g, '') };
      entries.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const versionMatch = /^\s+version\s+"([^"]+)"/.exec(line);
    if (versionMatch?.[1]) {
      current.version = versionMatch[1];
      continue;
    }

    const resolvedMatch = /^\s+resolved\s+"([^"]+)"/.exec(line);
    if (resolvedMatch?.[1]) {
      current.resolved = resolvedMatch[1];
    }
  }

  return entries;
}

function parseYarnBerryRequirementsFromContent(
  content: string,
  requiredBy: string
): { gitRequirements: GitRequirement[]; requirements: RootPackageRequirement[] } | undefined {
  let parsed: unknown;

  try {
    parsed = YAML.parse(content);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const requirements: RootPackageRequirement[] = [];
  const seen = new Set<string>();
  const gitRequirements: GitRequirement[] = [];
  const seenGit = new Set<string>();

  for (const [descriptor, value] of Object.entries(parsed)) {
    if (
      descriptor === '__metadata' ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      continue;
    }

    const entry = value as { resolution?: unknown; version?: unknown };
    if (typeof entry.version !== 'string') {
      continue;
    }

    const name =
      packageNameFromYarnResolution(entry.resolution) ?? packageNameFromYarnDescriptor(descriptor);
    const gitSpecifier =
      gitSpecifierFromYarnResolution(entry.resolution) ??
      gitSpecifierFromYarnDescriptor(descriptor);
    addGitRequirement(gitRequirements, seenGit, name, gitSpecifier, requiredBy);
    if (!gitSpecifier) {
      addRequirement(
        requirements,
        seen,
        name ? registryRequirement(name, entry.version, requiredBy) : undefined
      );
    }
  }

  return { gitRequirements, requirements };
}

export function parseYarnLockRequirementsFromContent(
  content: string,
  requiredBy: string
): ParseRootSpecsResult {
  const berry = parseYarnBerryRequirementsFromContent(content, requiredBy);
  const requirements = berry?.requirements ?? [];
  const seen = new Set(
    requirements.map((requirement) => `${requirement.name}\0${requirement.specifier}`)
  );
  const gitRequirements: GitRequirement[] = berry?.gitRequirements ?? [];
  const seenGit = new Set(
    gitRequirements.map(
      (requirement) => `${requirement.requiredBy}\0${requirement.raw}\0${requirement.rawSpec}`
    )
  );

  for (const entry of parseYarnClassicEntries(content)) {
    if (!entry.version) {
      continue;
    }

    const name =
      packageNameFromResolvedTarball(entry.resolved) ??
      packageNameFromYarnDescriptor(entry.descriptor);
    const gitSpecifier = gitSpecifierFromValues(
      entry.resolved,
      gitSpecifierFromYarnDescriptor(entry.descriptor)
    );
    addGitRequirement(gitRequirements, seenGit, name, gitSpecifier, requiredBy);
    if (!gitSpecifier) {
      addRequirement(
        requirements,
        seen,
        name ? registryRequirement(name, entry.version, requiredBy) : undefined
      );
    }
  }

  requirements.sort((left, right) => left.raw.localeCompare(right.raw));
  return { gitRequirements: sortGitRequirements(gitRequirements), requirements, unsupported: [] };
}

async function findLockfiles(rootDir: string): Promise<string[]> {
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

      if (entry.isFile() && supportedLockfileNames.has(entry.name)) {
        found.push(entryPath);
      }
    }
  }

  await walk(rootDir);
  return found.sort();
}

export function parseLockfileRequirementsFromContent(
  fileName: string,
  content: string,
  requiredBy: string
): ParseRootSpecsResult {
  if (fileName === 'pnpm-lock.yaml') {
    return parsePnpmLockRequirementsFromContent(content, requiredBy);
  }

  if (fileName === 'package-lock.json' || fileName === 'npm-shrinkwrap.json') {
    return parseNpmLockRequirementsFromContent(content, requiredBy);
  }

  if (fileName === 'yarn.lock') {
    return parseYarnLockRequirementsFromContent(content, requiredBy);
  }

  return { gitRequirements: [], requirements: [], unsupported: [] };
}

export async function readLockfileRequirements(root: string): Promise<ParseRootSpecsResult> {
  const rootDir = path.resolve(root);
  const stat = await fs.stat(rootDir);
  const searchRoot = stat.isDirectory() ? rootDir : path.dirname(rootDir);
  const files = await findLockfiles(searchRoot);
  const requirements: RootPackageRequirement[] = [];
  const seen = new Set<string>();
  const gitRequirements: GitRequirement[] = [];
  const seenGit = new Set<string>();

  for (const file of files) {
    const relativePath = path.relative(searchRoot, file) || path.basename(file);
    const parsed = parseLockfileRequirementsFromContent(
      path.basename(file),
      await fs.readFile(file, 'utf8'),
      `lockfile:${relativePath}`
    );

    for (const requirement of parsed.requirements) {
      addRequirement(requirements, seen, requirement);
    }

    for (const requirement of parsed.gitRequirements) {
      addGitRequirement(
        gitRequirements,
        seenGit,
        requirement.name,
        requirement.rawSpec,
        requirement.requiredBy
      );
    }
  }

  requirements.sort((left, right) => left.raw.localeCompare(right.raw));
  return { gitRequirements: sortGitRequirements(gitRequirements), requirements, unsupported: [] };
}
