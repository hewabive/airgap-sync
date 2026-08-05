import { semanticDigest } from '../canonical-json.js';
import { isBuiltInPlatformFamilyId, type BuiltInPlatformFamilyId } from './platform-family.js';

export type PythonWheelCollectionStrategy = 'minimum-cover';

export interface LinuxCoverageConstraint {
  oldestSupportedGlibc?: string;
}

export interface PlatformCoveragePolicy {
  features?: Record<string, string>;
  id: string;
  linux?: LinuxCoverageConstraint;
  platforms: BuiltInPlatformFamilyId[];
  version: 1;
  wheelStrategy: PythonWheelCollectionStrategy;
}

export interface InlinePlatformCoveragePolicy {
  features?: Record<string, string>;
  linux?: LinuxCoverageConstraint;
  platforms: BuiltInPlatformFamilyId[];
  version: 1;
  wheelStrategy: PythonWheelCollectionStrategy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFeatures(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('coverage features must be an object');
  }
  const entries = Object.entries(value)
    .map(([key, item]) => [key.trim(), typeof item === 'string' ? item.trim() : item] as const)
    .filter(([key]) => key.length > 0);
  if (entries.some(([, item]) => typeof item !== 'string' || item.length === 0)) {
    throw new Error('coverage feature values must be non-empty strings');
  }
  const normalized = Object.fromEntries(entries) as Record<string, string>;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeGlibcVersion(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^2\.\d+$/u.test(value.trim())) {
    throw new Error('oldestSupportedGlibc must be a glibc version such as 2.28');
  }
  return value.trim();
}

function normalizeCoverageFields(value: Record<string, unknown>): InlinePlatformCoveragePolicy {
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) {
    throw new Error('coverage policy platforms must be a non-empty array');
  }
  const platforms = value.platforms.map((platform) => {
    if (typeof platform !== 'string' || !isBuiltInPlatformFamilyId(platform)) {
      throw new Error(`Unsupported platform family: ${String(platform)}`);
    }
    return platform;
  });
  if (new Set(platforms).size !== platforms.length) {
    throw new Error('coverage policy platforms must not contain duplicates');
  }
  if (
    value.wheelStrategy !== undefined &&
    value.wheelStrategy !== 'minimum-cover' &&
    value.wheelStrategy !== 'all-compatible'
  ) {
    throw new Error('coverage policy wheelStrategy must be minimum-cover');
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new Error('coverage policy version must be 1');
  }

  const features = normalizeFeatures(value.features);
  const oldestSupportedGlibc = isRecord(value.linux)
    ? normalizeGlibcVersion(value.linux.oldestSupportedGlibc)
    : undefined;
  if (value.linux !== undefined && !isRecord(value.linux)) {
    throw new Error('coverage policy linux constraints must be an object');
  }
  if (oldestSupportedGlibc && !platforms.includes('linux-glibc-x86_64')) {
    throw new Error('oldestSupportedGlibc requires the linux-glibc-x86_64 platform family');
  }

  return {
    ...(features ? { features } : {}),
    ...(oldestSupportedGlibc ? { linux: { oldestSupportedGlibc } } : {}),
    platforms,
    version: 1,
    // `all-compatible` was written by pre-minimum-cover workspaces. Reading it as the
    // current strategy keeps those workspaces usable without preserving obsolete behavior.
    wheelStrategy: 'minimum-cover',
  };
}

export function normalizeInlinePlatformCoveragePolicy(
  value: unknown
): InlinePlatformCoveragePolicy {
  if (!isRecord(value)) {
    throw new Error('inline coverage policy must be an object');
  }
  return normalizeCoverageFields(value);
}

export function normalizePlatformCoveragePolicy(value: unknown): PlatformCoveragePolicy {
  if (!isRecord(value)) {
    throw new Error('coverage policy must be an object');
  }
  if (typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw new Error('coverage policy id must be a non-empty string');
  }
  return {
    id: value.id.trim(),
    ...normalizeCoverageFields(value),
  };
}

export function platformCoveragePolicyDigest(
  policy: PlatformCoveragePolicy | InlinePlatformCoveragePolicy
): string {
  const semanticPolicy: Record<string, unknown> = { ...policy };
  delete semanticPolicy.id;
  return semanticDigest(semanticPolicy);
}
