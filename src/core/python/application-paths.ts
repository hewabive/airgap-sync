import path from 'node:path';
import { semanticDigest } from '../canonical-json.js';
import type { PythonApplicationVersionSelector } from './application-intent.js';
import { normalizePackageName } from './names.js';

export const pythonApplicationsDirectory = 'python/applications';
export const pythonApplicationIndexPath = 'python/application-index.json';
export const pythonWheelArtifactsDirectory = 'python/artifacts/wheels';
export const pythonOptionalArtifactsDirectory = 'python/artifacts/optional';

export function pythonApplicationTargetId(
  applicationName: string,
  coveragePolicyId: string
): string {
  const normalizedApplication = normalizePackageName(applicationName);
  const normalizedCoverage = coveragePolicyId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (!normalizedCoverage) {
    throw new Error('coverage policy id cannot produce an empty path component');
  }
  return `${normalizedApplication}--${normalizedCoverage}`;
}

function identityComponent(value: string): string {
  const normalized = value.trim().toLowerCase();
  const safe = normalized.replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!safe) {
    throw new Error('Python application identity component cannot be empty');
  }
  return safe === normalized ? safe : `${safe}-${semanticDigest(normalized).slice(0, 8)}`;
}

export function pythonApplicationVariantId(
  applicationName: string,
  applicationVersion: string,
  coveragePolicyId: string
): string {
  return `${pythonApplicationTargetId(applicationName, coveragePolicyId)}--version-${identityComponent(applicationVersion)}`;
}

export function pythonApplicationSelectorId(
  applicationName: string,
  coveragePolicyId: string,
  selector: PythonApplicationVersionSelector
): string {
  if (selector.type === 'exact') {
    return pythonApplicationVariantId(applicationName, selector.version, coveragePolicyId);
  }
  const base = `${pythonApplicationTargetId(applicationName, coveragePolicyId)}--selector-latest`;
  return selector.constraint ? `${base}-${semanticDigest(selector.constraint).slice(0, 8)}` : base;
}

export function pythonApplicationPlanDirectory(targetId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*--[a-z0-9][a-z0-9._-]*$/u.test(targetId)) {
    throw new Error(`Invalid Python application target id: ${targetId}`);
  }
  return path.posix.join(pythonApplicationsDirectory, targetId);
}

export function pythonApplicationPlanPath(targetId: string): string {
  return path.posix.join(pythonApplicationPlanDirectory(targetId), 'environment-plan.json');
}

export function pythonPlatformLockBase(platformFamilyId: string, pythonMinor: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(platformFamilyId)) {
    throw new Error(`Invalid Python platform family id: ${platformFamilyId}`);
  }
  if (!/^3\.\d+$/u.test(pythonMinor)) {
    throw new Error(`Invalid Python minor: ${pythonMinor}`);
  }
  return `${platformFamilyId}--py${pythonMinor.replace('.', '')}`;
}

export function pythonPlatformPylockPath(platformFamilyId: string, pythonMinor: string): string {
  return path.posix.join(
    'lock',
    `${pythonPlatformLockBase(platformFamilyId, pythonMinor)}.pylock.toml`
  );
}

export function pythonPlatformRequirementsLockPath(
  platformFamilyId: string,
  pythonMinor: string
): string {
  return path.posix.join(
    'lock',
    `${pythonPlatformLockBase(platformFamilyId, pythonMinor)}.requirements.lock`
  );
}
