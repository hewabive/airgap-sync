import { parse as parseToml } from 'smol-toml';
import type {
  PythonLockedPackage,
  PythonLockedSourceKind,
  PythonLockInput,
} from './input-types.js';
import {
  isRecord,
  parseDependencyGroups,
  parseLockedDependencies,
  parseLockedFile,
  stringArray,
} from './lock-utils.js';
import { isValidVersion } from './pep440.js';
import { isValidPackageName, normalizePackageName } from './names.js';

const maximumSupportedRevision = 3;

function sourceDetails(value: unknown): { kind: PythonLockedSourceKind; source?: string } {
  if (!isRecord(value)) {
    return { kind: 'unknown' };
  }
  for (const kind of ['registry', 'editable', 'virtual', 'directory', 'git', 'url'] as const) {
    const source = value[kind];
    if (typeof source !== 'string') {
      continue;
    }
    const mappedKind: PythonLockedSourceKind =
      kind === 'git' ? 'vcs' : kind === 'url' ? 'archive' : kind;
    return { kind: mappedKind, source: JSON.stringify(value) };
  }
  return { kind: 'unknown', source: JSON.stringify(value) };
}

function parsePackage(value: unknown, sourcePath: string): PythonLockedPackage {
  if (!isRecord(value) || typeof value.name !== 'string' || !isValidPackageName(value.name)) {
    throw new Error(`${sourcePath} contains a package with an invalid or missing name`);
  }
  if (
    value.version !== undefined &&
    (typeof value.version !== 'string' || !isValidVersion(value.version))
  ) {
    throw new Error(`${sourcePath} contains an invalid version for ${value.name}`);
  }
  const source = sourceDetails(value.source);
  if (source.kind === 'registry' && typeof value.version !== 'string') {
    throw new Error(`${sourcePath} registry package ${value.name} is missing a version`);
  }
  const wheels = Array.isArray(value.wheels)
    ? value.wheels.flatMap((wheel) => {
        const parsed = parseLockedFile(wheel);
        return parsed ? [parsed] : [];
      })
    : [];

  return {
    dependencies: parseLockedDependencies(value.dependencies),
    devDependencies: parseDependencyGroups(value['dev-dependencies']),
    name: normalizePackageName(value.name),
    optionalDependencies: parseDependencyGroups(value['optional-dependencies']),
    sourceKind: source.kind,
    wheels,
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    ...(source.source ? { source: source.source } : {}),
    ...(typeof value['requires-python'] === 'string'
      ? { requiresPython: value['requires-python'] }
      : {}),
  };
}

export function parseUvLock(content: string, sourcePath = 'uv.lock'): PythonLockInput {
  const value: unknown = parseToml(content);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.package)) {
    throw new Error(`${sourcePath} uses an unsupported uv.lock schema version`);
  }
  const revision = value.revision;
  if (
    revision !== undefined &&
    (typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision > maximumSupportedRevision)
  ) {
    const description =
      typeof revision === 'number' || typeof revision === 'string'
        ? String(revision)
        : 'non-numeric value';
    throw new Error(`${sourcePath} uses unsupported uv.lock revision ${description}`);
  }

  return {
    defaultGroups: [],
    dependencyGroups: [],
    environments: stringArray(value['resolution-markers']),
    extras: [],
    format: 'uv',
    packages: value.package.map((item) => parsePackage(item, sourcePath)),
    sourcePath,
    version: `1${revision === undefined ? '' : `.${String(revision)}`}`,
    ...(typeof value['requires-python'] === 'string'
      ? { requiresPython: value['requires-python'] }
      : {}),
  };
}
