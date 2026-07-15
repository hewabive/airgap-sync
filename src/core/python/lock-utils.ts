import path from 'node:path';
import { normalizeHashes } from './integrity.js';
import type { PythonLockedDependency, PythonLockedFile } from './input-types.js';
import { normalizePackageName } from './names.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function parseLockedDependencies(value: unknown): PythonLockedDependency[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): PythonLockedDependency[] => {
    if (!isRecord(item) || typeof item.name !== 'string') {
      return [];
    }
    const source = isRecord(item.source) ? JSON.stringify(item.source) : undefined;
    return [
      {
        ...(Array.isArray(item.extra)
          ? {
              extras: item.extra
                .filter((extra): extra is string => typeof extra === 'string')
                .map(normalizePackageName),
            }
          : {}),
        name: normalizePackageName(item.name),
        ...(typeof item.version === 'string' ? { version: item.version } : {}),
        ...(typeof item.marker === 'string' ? { marker: item.marker } : {}),
        ...(source ? { source } : {}),
      },
    ];
  });
}

export function parseDependencyGroups(value: unknown): Record<string, PythonLockedDependency[]> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, dependencies]) => [name, parseLockedDependencies(dependencies)])
  );
}

function filenameFromUrl(url: string): string {
  const parsed = new URL(url);
  const filename = decodeURIComponent(path.posix.basename(parsed.pathname));
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    throw new Error(`Lockfile contains an unsafe package filename: ${filename}`);
  }
  return filename;
}

export function parseLockedFile(
  value: unknown,
  options: { hashField?: 'hash' | 'hashes'; nameField?: boolean } = {}
): PythonLockedFile | undefined {
  if (!isRecord(value) || typeof value.url !== 'string') {
    return undefined;
  }
  const parsedUrl = new URL(value.url);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return undefined;
  }
  const filename =
    options.nameField && typeof value.name === 'string' ? value.name : filenameFromUrl(value.url);
  const hashes =
    options.hashField === 'hashes'
      ? normalizeHashes(value.hashes)
      : typeof value.hash === 'string'
        ? (() => {
            const separator = value.hash.indexOf(':');
            return separator > 0
              ? normalizeHashes({
                  [value.hash.slice(0, separator)]: value.hash.slice(separator + 1),
                })
              : {};
          })()
        : {};
  return {
    filename,
    hashes,
    url: parsedUrl.toString(),
    ...(typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
      ? { size: value.size }
      : {}),
  };
}
