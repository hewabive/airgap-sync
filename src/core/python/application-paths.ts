import path from 'node:path';
import { normalizePackageName } from './names.js';

export const pythonApplicationsDirectory = 'python/applications';

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

export function pythonApplicationPlanDirectory(targetId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*--[a-z0-9][a-z0-9._-]*$/u.test(targetId)) {
    throw new Error(`Invalid Python application target id: ${targetId}`);
  }
  return path.posix.join(pythonApplicationsDirectory, targetId);
}

export function pythonApplicationPlanPath(targetId: string): string {
  return path.posix.join(pythonApplicationPlanDirectory(targetId), 'environment-plan.json');
}
