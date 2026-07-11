const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

export function isValidPackageName(name: string): boolean {
  return !name.endsWith('\n') && !name.endsWith('\r') && NAME_PATTERN.test(name);
}

export function normalizePackageName(name: string): string {
  return name.replace(/[-_.]+/g, '-').toLowerCase();
}

export function escapePackageNameForFilename(name: string): string {
  return normalizePackageName(name).replace(/-/g, '_');
}
