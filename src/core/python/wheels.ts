import { normalizePackageName } from './names.js';
import { isValidVersion } from './pep440.js';

export interface WheelFilename {
  abiTags: string[];
  buildTag?: string;
  distribution: string;
  normalizedName: string;
  platformTags: string[];
  pythonTags: string[];
  raw: string;
  version: string;
}

export function parseWheelFilename(filename: string): WheelFilename | undefined {
  if (!filename.endsWith('.whl')) {
    return undefined;
  }

  const parts = filename.slice(0, -'.whl'.length).split('-');
  if (parts.length !== 5 && parts.length !== 6) {
    return undefined;
  }

  const [distribution, version] = parts as [string, string, ...string[]];
  const buildTag = parts.length === 6 ? parts[2] : undefined;
  const pythonTag = parts[parts.length - 3]!;
  const abiTag = parts[parts.length - 2]!;
  const platformTag = parts[parts.length - 1]!;

  if (!distribution || !isValidVersion(version)) {
    return undefined;
  }

  if (buildTag !== undefined && !/^\d/.test(buildTag)) {
    return undefined;
  }

  if (!pythonTag || !abiTag || !platformTag) {
    return undefined;
  }

  return {
    abiTags: abiTag.split('.'),
    distribution,
    normalizedName: normalizePackageName(distribution),
    platformTags: platformTag.split('.'),
    pythonTags: pythonTag.split('.'),
    raw: filename,
    version,
    ...(buildTag !== undefined ? { buildTag } : {}),
  };
}

export function expandWheelTags(wheel: WheelFilename): string[] {
  const tags: string[] = [];
  for (const pythonTag of wheel.pythonTags) {
    for (const abiTag of wheel.abiTags) {
      for (const platformTag of wheel.platformTags) {
        tags.push(`${pythonTag}-${abiTag}-${platformTag}`);
      }
    }
  }
  return tags;
}

export interface SdistFilename {
  distribution: string;
  normalizedName: string;
  raw: string;
  version: string;
}

const SDIST_EXTENSIONS = ['.tar.gz', '.zip', '.tar.bz2'];

export function parseSdistFilename(filename: string): SdistFilename | undefined {
  const extension = SDIST_EXTENSIONS.find((candidate) => filename.endsWith(candidate));
  if (!extension) {
    return undefined;
  }

  const stem = filename.slice(0, -extension.length);
  const separator = stem.lastIndexOf('-');
  if (separator <= 0) {
    return undefined;
  }

  const distribution = stem.slice(0, separator);
  const version = stem.slice(separator + 1);
  if (!version || !isValidVersion(version)) {
    return undefined;
  }

  return {
    distribution,
    normalizedName: normalizePackageName(distribution),
    raw: filename,
    version,
  };
}
