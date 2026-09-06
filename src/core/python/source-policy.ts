import { isValidPackageName, normalizePackageName } from './names.js';

export interface PythonResolutionPolicy {
  prereleasePackages?: string[];
  packageIndexes?: {
    indexUrl: string;
    packages: string[];
    missingUploadTime?: 'allow' | 'reject';
  }[];
  prerelease?: 'allow' | 'disallow' | 'if-necessary-or-explicit';
}

export function normalizePythonResolutionPolicy(
  value: unknown
): PythonResolutionPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Python resolution must be an object');
  }
  const policy = value as Record<string, unknown>;
  if (
    policy.prerelease !== undefined &&
    (typeof policy.prerelease !== 'string' ||
      !['allow', 'disallow', 'if-necessary-or-explicit'].includes(policy.prerelease))
  ) {
    throw new Error(
      'Python resolution.prerelease must be allow, disallow, or if-necessary-or-explicit'
    );
  }
  let prereleasePackages: string[] | undefined;
  if (policy.prereleasePackages !== undefined) {
    if (policy.prerelease !== undefined)
      throw new Error('Use prerelease or prereleasePackages, not both');
    if (
      !Array.isArray(policy.prereleasePackages) ||
      !policy.prereleasePackages.every(
        (name): name is string => typeof name === 'string' && isValidPackageName(name)
      )
    ) {
      throw new Error('Python resolution.prereleasePackages must contain package names');
    }
    prereleasePackages = [...new Set(policy.prereleasePackages.map(normalizePackageName))].sort();
  }
  const names = new Set<string>();
  if (policy.packageIndexes !== undefined && !Array.isArray(policy.packageIndexes)) {
    throw new Error('Python resolution.packageIndexes must be an array');
  }
  const packageIndexes = (policy.packageIndexes as unknown[] | undefined)?.map(
    (value): NonNullable<PythonResolutionPolicy['packageIndexes']>[number] => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Python package index must be an object');
      const entry = value as Record<string, unknown>;
      if (typeof entry.indexUrl !== 'string')
        throw new Error('Python package index requires indexUrl');
      const url = new URL(entry.indexUrl);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error(
          'Python package index must be an HTTP(S) URL without credentials, query, or fragment'
        );
      }
      if (!Array.isArray(entry.packages) || entry.packages.length === 0)
        throw new Error('Python package index requires packages');
      const packages = entry.packages
        .map((name: unknown) => {
          if (typeof name !== 'string' || !isValidPackageName(name))
            throw new Error('Invalid Python index package name');
          const normalized = normalizePackageName(name);
          if (names.has(normalized))
            throw new Error(`Duplicate Python index assignment: ${normalized}`);
          names.add(normalized);
          return normalized;
        })
        .sort();
      if (
        entry.missingUploadTime !== undefined &&
        entry.missingUploadTime !== 'allow' &&
        entry.missingUploadTime !== 'reject'
      ) {
        throw new Error('Python package index missingUploadTime must be allow or reject');
      }
      return {
        indexUrl: url.toString(),
        packages,
        ...(entry.missingUploadTime ? { missingUploadTime: entry.missingUploadTime } : {}),
      };
    }
  );
  return {
    ...(packageIndexes ? { packageIndexes } : {}),
    ...(prereleasePackages ? { prereleasePackages } : {}),
    ...(policy.prerelease
      ? { prerelease: policy.prerelease as NonNullable<PythonResolutionPolicy['prerelease']> }
      : {}),
  };
}
