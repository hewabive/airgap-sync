import semver from 'semver';
import type {
  ParseRootSpecsResult,
  ProjectPackageManifest,
  ProjectPackageManagerEngine,
  RootPackageRequirement,
  UnsupportedRootPackageRequirement,
} from '../types.js';
import { parseDependencySpec } from './specs.js';

const packageManagerRequiredByPrefix = 'package-manager:';

export interface PackageManagerManifestEntry {
  manifest: ProjectPackageManifest;
  pnpmLockfileCovered?: boolean;
  requiredBy: string;
}

function packageManagerRequiredBy(requiredBy: string): string {
  return `${packageManagerRequiredByPrefix}${requiredBy}`;
}

function packageManagerUnsupported(
  raw: string,
  requiredBy: string,
  reason: string
): UnsupportedRootPackageRequirement {
  return {
    raw,
    reason,
    requiredBy: packageManagerRequiredBy(requiredBy),
    type: 'package-manager',
  };
}

function addPnpmRequirements(
  specifier: string,
  requiredBy: string,
  requirements: RootPackageRequirement[],
  unsupported: UnsupportedRootPackageRequirement[]
): void {
  const source = packageManagerRequiredBy(requiredBy);

  for (const name of ['pnpm', '@pnpm/exe']) {
    const requirement = parseDependencySpec(name, specifier, source);
    if ('reason' in requirement) {
      unsupported.push({
        ...requirement,
        reason: `Unsupported pnpm package manager version: ${requirement.reason}`,
        type: 'package-manager',
      });
    } else {
      requirements.push(requirement);
    }
  }
}

function stripCorepackIntegrity(reference: string): string {
  return reference.replace(/\+sha(?:224|256|384|512)\.[A-Za-z0-9+/=_-]+$/u, '');
}

function parseLegacyPackageManager(
  value: string,
  requiredBy: string,
  requirements: RootPackageRequirement[],
  unsupported: UnsupportedRootPackageRequirement[]
): void {
  const normalized = value.trim();
  if (!normalized.startsWith('pnpm@')) {
    return;
  }

  const version = stripCorepackIntegrity(normalized.slice('pnpm@'.length));
  if (!semver.valid(version)) {
    unsupported.push(
      packageManagerUnsupported(
        normalized,
        requiredBy,
        'pnpm packageManager must declare an exact semantic version'
      )
    );
    return;
  }

  addPnpmRequirements(version, requiredBy, requirements, unsupported);
}

function selectedDevEngine(
  value: ProjectPackageManifest['devEngines']
): ProjectPackageManagerEngine | undefined {
  const packageManagers = value?.packageManager;
  if (!packageManagers) {
    return undefined;
  }

  const entries: unknown[] = Array.isArray(packageManagers) ? packageManagers : [packageManagers];
  return entries.find(
    (entry): entry is ProjectPackageManagerEngine =>
      typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === 'pnpm'
  );
}

function parseDevEnginePackageManager(
  engine: ProjectPackageManagerEngine,
  entry: PackageManagerManifestEntry,
  requirements: RootPackageRequirement[],
  unsupported: UnsupportedRootPackageRequirement[]
): void {
  if (entry.pnpmLockfileCovered === true) {
    return;
  }

  const version = engine.version?.trim();
  if (!version || !semver.validRange(version)) {
    unsupported.push(
      packageManagerUnsupported(
        `pnpm@${version ?? ''}`,
        entry.requiredBy,
        'devEngines.packageManager for pnpm must declare a valid semantic version range'
      )
    );
    return;
  }

  addPnpmRequirements(version, entry.requiredBy, requirements, unsupported);
}

export function parsePackageManagerRequirements(
  entries: PackageManagerManifestEntry[]
): ParseRootSpecsResult {
  const requirements: RootPackageRequirement[] = [];
  const unsupported: UnsupportedRootPackageRequirement[] = [];

  for (const entry of entries) {
    const devEngine = selectedDevEngine(entry.manifest.devEngines);
    if (devEngine) {
      parseDevEnginePackageManager(devEngine, entry, requirements, unsupported);
      continue;
    }

    if (typeof entry.manifest.packageManager === 'string') {
      parseLegacyPackageManager(
        entry.manifest.packageManager,
        entry.requiredBy,
        requirements,
        unsupported
      );
    }
  }

  return {
    gitRequirements: [],
    requirements,
    unsupported,
  };
}

export function isPackageManagerRequirement(requirement: RootPackageRequirement): boolean {
  return requirement.requiredBy.startsWith(packageManagerRequiredByPrefix);
}
