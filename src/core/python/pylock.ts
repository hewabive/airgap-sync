import { parse as parseToml } from 'smol-toml';
import type {
  PythonLockedPackage,
  PythonLockedSourceKind,
  PythonLockInput,
} from './input-types.js';
import { isRecord, parseLockedDependencies, parseLockedFile, stringArray } from './lock-utils.js';
import { isValidPackageName, normalizePackageName } from './names.js';
import { isValidVersion } from './pep440.js';

function sourceKind(value: Record<string, unknown>): PythonLockedSourceKind {
  if (Array.isArray(value.wheels) || isRecord(value.sdist)) {
    return 'registry';
  }
  if (isRecord(value.vcs)) {
    return 'vcs';
  }
  if (isRecord(value.directory)) {
    return 'directory';
  }
  if (isRecord(value.archive)) {
    return 'archive';
  }
  return 'unknown';
}

function sourceValue(
  value: Record<string, unknown>,
  kind: PythonLockedSourceKind
): string | undefined {
  if (kind === 'registry') {
    return typeof value.index === 'string' ? value.index : undefined;
  }
  const source = value[kind];
  return isRecord(source) ? JSON.stringify(source) : undefined;
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
  const kind = sourceKind(value);
  const wheels = Array.isArray(value.wheels)
    ? value.wheels.flatMap((wheel) => {
        const parsed = parseLockedFile(wheel, { hashField: 'hashes', nameField: true });
        return parsed ? [parsed] : [];
      })
    : [];
  if (kind === 'registry' && typeof value.version !== 'string') {
    throw new Error(`${sourcePath} registry package ${value.name} has no version`);
  }
  const source = sourceValue(value, kind);

  return {
    dependencies: parseLockedDependencies(value.dependencies),
    devDependencies: {},
    name: normalizePackageName(value.name),
    optionalDependencies: {},
    sourceKind: kind,
    wheels,
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    ...(typeof value.marker === 'string' ? { marker: value.marker } : {}),
    ...(typeof value['requires-python'] === 'string'
      ? { requiresPython: value['requires-python'] }
      : {}),
    ...(source ? { source } : {}),
  };
}

export function parsePylock(content: string, sourcePath = 'pylock.toml'): PythonLockInput {
  const value: unknown = parseToml(content);
  if (!isRecord(value) || value['lock-version'] !== '1.0' || !Array.isArray(value.packages)) {
    throw new Error(`${sourcePath} uses an unsupported pylock.toml schema version`);
  }
  if (typeof value['created-by'] !== 'string' || !value['created-by']) {
    throw new Error(`${sourcePath} is missing created-by`);
  }

  return {
    createdBy: value['created-by'],
    defaultGroups: stringArray(value['default-groups']),
    dependencyGroups: stringArray(value['dependency-groups']),
    environments: stringArray(value.environments),
    extras: stringArray(value.extras),
    format: 'pylock',
    packages: value.packages.map((item) => parsePackage(item, sourcePath)),
    sourcePath,
    version: '1.0',
    ...(typeof value['requires-python'] === 'string'
      ? { requiresPython: value['requires-python'] }
      : {}),
  };
}
