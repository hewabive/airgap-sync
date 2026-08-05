import { compare, explain, maxSatisfying, satisfies, valid, validRange } from '@renovatebot/pep440';

export function isValidVersion(version: string): boolean {
  return valid(version) !== null;
}

export function normalizeVersion(version: string): string | null {
  return valid(version);
}

export function isValidSpecifierSet(specifiers: string): boolean {
  return validRange(specifiers);
}

export function compareVersions(a: string, b: string): number {
  return compare(a, b);
}

export function versionSatisfies(version: string, specifiers: string): boolean {
  if (!specifiers.trim()) {
    return true;
  }

  return satisfies(version, specifiers);
}

export function isPrereleaseVersion(version: string): boolean {
  const parsed = explain(version);
  return parsed ? parsed.is_prerelease : false;
}

export function maxSatisfyingVersion(versions: string[], specifiers: string): string | null {
  return maxSatisfying(versions, specifiers);
}
