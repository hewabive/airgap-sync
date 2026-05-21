import path from 'node:path';
import fs from 'fs-extra';
import semver from 'semver';
import YAML from 'yaml';
import type { ParseRootSpecsResult, RootPackageRequirement } from '../types.js';

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

function parsePackageKey(key: string): { name: string; version: string } | undefined {
  const withoutPeerSuffix = key.replace(/^\//, '').split('(')[0] ?? '';
  const versionSeparator = withoutPeerSuffix.lastIndexOf('@');

  if (versionSeparator <= 0) {
    return undefined;
  }

  const name = withoutPeerSuffix.slice(0, versionSeparator);
  const version = withoutPeerSuffix.slice(versionSeparator + 1);

  if (!name || !semver.valid(version)) {
    return undefined;
  }

  return { name, version };
}

function requirementFromPackageKey(key: string, requiredBy: string): RootPackageRequirement | undefined {
  const parsed = parsePackageKey(key);
  if (!parsed) {
    return undefined;
  }

  return {
    name: parsed.name,
    raw: `${parsed.name}@${parsed.version}`,
    requiredBy,
    specifier: parsed.version,
    type: 'version',
  };
}

export function parsePnpmLockRequirementsFromContent(
  content: string,
  requiredBy: string
): ParseRootSpecsResult {
  const parsed = YAML.parse(content) as { packages?: unknown; snapshots?: unknown } | null;
  const packageKeys = new Set<string>();

  for (const section of [parsed?.packages, parsed?.snapshots]) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      continue;
    }

    for (const key of Object.keys(section)) {
      packageKeys.add(key);
    }
  }

  const requirements: RootPackageRequirement[] = [];
  const seen = new Set<string>();

  for (const key of packageKeys) {
    const requirement = requirementFromPackageKey(key, requiredBy);
    if (!requirement) {
      continue;
    }

    const id = `${requirement.name}\0${requirement.specifier}`;
    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    requirements.push(requirement);
  }

  requirements.sort((left, right) => left.raw.localeCompare(right.raw));
  return { gitRequirements: [], requirements, unsupported: [] };
}

async function findPnpmLockFiles(rootDir: string): Promise<string[]> {
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

      if (entry.isFile() && entry.name === 'pnpm-lock.yaml') {
        found.push(entryPath);
      }
    }
  }

  await walk(rootDir);
  return found.sort();
}

export async function readPnpmLockRequirements(root: string): Promise<ParseRootSpecsResult> {
  const rootDir = path.resolve(root);
  const stat = await fs.stat(rootDir);
  const searchRoot = stat.isDirectory() ? rootDir : path.dirname(rootDir);
  const files = await findPnpmLockFiles(searchRoot);
  const requirements: RootPackageRequirement[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const relativePath = path.relative(searchRoot, file) || path.basename(file);
    const parsed = parsePnpmLockRequirementsFromContent(
      await fs.readFile(file, 'utf8'),
      `pnpm-lock:${relativePath}`
    );

    for (const requirement of parsed.requirements) {
      const id = `${requirement.name}\0${requirement.specifier}`;
      if (seen.has(id)) {
        continue;
      }

      seen.add(id);
      requirements.push(requirement);
    }
  }

  return { gitRequirements: [], requirements, unsupported: [] };
}
