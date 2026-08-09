import path from 'node:path';
import type {
  PythonDiscoveredInputs,
  PythonRequirementInput,
  UnsupportedPythonInput,
} from './input-types.js';
import { parsePylock } from './pylock.js';
import { parseRequirementsText } from './requirements-txt.js';
import { parseUvLock } from './uv-lock.js';
import * as fs from '../fs.js';

const developmentNamePattern = /(?:^|[-_.])(dev|docs|lint|test|tests)(?:[-_.]|$)/i;
const pylockNamePattern = /^pylock(?:\.[^.]+)?\.toml$/;
const ignoredDirectories = new Set([
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'build',
  'coverage',
  'dist',
  'fixtures',
  'node_modules',
]);

function isRequirementPath(filePath: string): boolean {
  const basename = path.posix.basename(filePath);
  return basename.startsWith('requirements') && basename.endsWith('.txt');
}

function isDevelopmentRequirementPath(filePath: string): boolean {
  const stem = path.posix.basename(filePath, '.txt');
  return stem !== 'requirements' && developmentNamePattern.test(stem.slice('requirements'.length));
}

function isPythonLockPath(filePath: string): boolean {
  const basename = path.posix.basename(filePath);
  return basename === 'uv.lock' || pylockNamePattern.test(basename);
}

function sameDirectory(left: string, right: string): boolean {
  return path.posix.dirname(left) === path.posix.dirname(right);
}

function requirementKey(input: PythonRequirementInput): string {
  return [
    input.constraint ? 'constraint' : 'requirement',
    input.requirement.normalizedName,
    input.requirement.specifier,
    input.requirement.marker ?? '',
    input.sourcePath,
    String(input.line),
  ].join('\0');
}

function unsupportedKey(input: UnsupportedPythonInput): string {
  return [input.sourcePath, String(input.line ?? ''), input.type, input.raw].join('\0');
}

export async function discoverPythonInputsFromPaths(
  repositoryPaths: string[],
  readFile: (filePath: string) => Promise<string>,
  options: { includeDev?: boolean } = {}
): Promise<PythonDiscoveredInputs> {
  const available = new Set(repositoryPaths);
  const requirementPaths = repositoryPaths
    .filter(isRequirementPath)
    .filter((filePath) => options.includeDev === true || !isDevelopmentRequirementPath(filePath))
    .sort(
      (left, right) =>
        Number(isDevelopmentRequirementPath(left)) - Number(isDevelopmentRequirementPath(right)) ||
        left.localeCompare(right)
    );
  const lockfilePaths = repositoryPaths.filter(isPythonLockPath).sort();
  const requirements = new Map<string, PythonRequirementInput>();
  const unsupported = new Map<string, UnsupportedPythonInput>();
  const parsedRequirementFiles = new Set<string>();

  for (const requirementPath of requirementPaths) {
    if (parsedRequirementFiles.has(requirementPath)) {
      continue;
    }
    const parsed = await parseRequirementsText(await readFile(requirementPath), {
      readIncluded(filePath) {
        if (!available.has(filePath)) {
          return Promise.reject(new Error('file is not present in the Git revision'));
        }
        return readFile(filePath);
      },
      sourcePath: requirementPath,
    });
    parsed.files.forEach((file) => parsedRequirementFiles.add(file));
    parsed.requirements.forEach((input) => requirements.set(requirementKey(input), input));
    parsed.unsupported.forEach((input) => unsupported.set(unsupportedKey(input), input));
  }

  const lockfiles = [];
  for (const lockfilePath of lockfilePaths) {
    const content = await readFile(lockfilePath);
    lockfiles.push(
      path.posix.basename(lockfilePath) === 'uv.lock'
        ? parseUvLock(content, lockfilePath)
        : parsePylock(content, lockfilePath)
    );
  }

  const pyprojectPaths = repositoryPaths.filter(
    (filePath) => path.posix.basename(filePath) === 'pyproject.toml'
  );
  const pyprojectWithoutLock = pyprojectPaths.filter(
    (pyprojectPath) =>
      !lockfilePaths.some((lockfilePath) => sameDirectory(pyprojectPath, lockfilePath))
  );
  for (const pyprojectPath of pyprojectWithoutLock) {
    const input: UnsupportedPythonInput = {
      raw: pyprojectPath,
      reason: 'pyproject.toml requires uv.lock, pylock.toml, or explicit pypi targets in v1',
      requiredBy: `pyproject:${pyprojectPath}`,
      sourcePath: pyprojectPath,
      type: 'pyproject-without-lock',
    };
    unsupported.set(unsupportedKey(input), input);
  }

  return {
    lockfiles,
    lockfilePaths,
    pyprojectWithoutLock,
    requirements: [...requirements.values()],
    requirementPaths: [...parsedRequirementFiles].sort(),
    unsupported: [...unsupported.values()],
  };
}

export function emptyPythonDiscoveredInputs(): PythonDiscoveredInputs {
  return {
    lockfiles: [],
    lockfilePaths: [],
    pyprojectWithoutLock: [],
    requirements: [],
    requirementPaths: [],
    unsupported: [],
  };
}

export async function discoverPythonInputs(
  root: string,
  options: { includeDev?: boolean } = {}
): Promise<PythonDiscoveredInputs> {
  const absoluteRoot = path.resolve(root);
  const paths: string[] = [];

  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(path.join(directory, entry.name));
        }
        continue;
      }
      if (entry.isFile()) {
        paths.push(
          path.relative(absoluteRoot, path.join(directory, entry.name)).replace(/\\/g, '/')
        );
      }
    }
  }

  await walk(absoluteRoot);
  return discoverPythonInputsFromPaths(
    paths.sort(),
    (filePath) => fs.readFile(path.join(absoluteRoot, filePath), 'utf8'),
    options
  );
}
