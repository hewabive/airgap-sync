import type { PlatformLibcFamily } from './platform-family.js';
import catalogData from '../../../support/python/distribution-hints.json' with { type: 'json' };

export interface DistributionHint {
  aliases: string[];
  distributionId: string;
  libc: {
    family: PlatformLibcFamily;
    version: string;
  };
  notes?: string[];
  release: string;
}

export interface DistributionHintCatalog {
  catalogVersion: string;
  entries: DistributionHint[];
  lastReviewedAt: string;
  provenance: {
    title: string;
    url: string;
  }[];
  schemaVersion: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown, description: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${description} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

export function normalizeDistributionHintCatalog(value: unknown): DistributionHintCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('distribution hint catalog schemaVersion must be 1');
  }
  if (typeof value.catalogVersion !== 'string' || !value.catalogVersion.trim()) {
    throw new Error('distribution hint catalog must have a catalogVersion');
  }
  if (
    typeof value.lastReviewedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value.lastReviewedAt)
  ) {
    throw new Error('distribution hint catalog lastReviewedAt must use YYYY-MM-DD');
  }
  if (!Array.isArray(value.provenance) || !Array.isArray(value.entries)) {
    throw new Error('distribution hint catalog must contain provenance and entries arrays');
  }

  const provenance = value.provenance.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      typeof item.url !== 'string'
    ) {
      throw new Error('distribution hint provenance entries require title and url');
    }
    const url = new URL(item.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('distribution hint provenance URLs must use HTTP or HTTPS');
    }
    return {
      title: item.title.trim(),
      url: url.toString(),
    };
  });

  const entries = value.entries.map<DistributionHint>((item) => {
    if (
      !isRecord(item) ||
      typeof item.distributionId !== 'string' ||
      !item.distributionId.trim() ||
      typeof item.release !== 'string' ||
      !item.release.trim() ||
      !isRecord(item.libc) ||
      (item.libc.family !== 'glibc' && item.libc.family !== 'musl') ||
      typeof item.libc.version !== 'string' ||
      !/^\d+\.\d+$/u.test(item.libc.version)
    ) {
      throw new Error('invalid distribution hint entry');
    }
    const aliases = normalizeStringArray(item.aliases, 'distribution hint aliases');
    const notes =
      item.notes === undefined
        ? undefined
        : normalizeStringArray(item.notes, 'distribution hint notes');
    return {
      aliases,
      distributionId: item.distributionId.trim().toLowerCase(),
      libc: {
        family: item.libc.family,
        version: item.libc.version,
      },
      ...(notes && notes.length > 0 ? { notes } : {}),
      release: item.release.trim(),
    };
  });

  const keys = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.distributionId}\0${entry.release}`;
    if (keys.has(key)) {
      throw new Error(`duplicate distribution hint: ${entry.distributionId} ${entry.release}`);
    }
    keys.add(key);
  }

  return {
    catalogVersion: value.catalogVersion.trim(),
    entries,
    lastReviewedAt: value.lastReviewedAt,
    provenance,
    schemaVersion: 1,
  };
}

export const builtInDistributionHintCatalog = normalizeDistributionHintCatalog(catalogData);
