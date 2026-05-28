import path from 'node:path';
import type {
  ApplyBundleReport,
  BundleManifest,
  BundlePruneReport,
  CollectReport,
  DistTagsManifest,
  FetchPackageAction,
  TagResolutionPolicy,
  RangeResolutionPolicy,
} from '../types.js';
import * as fs from './fs.js';

export interface BundleStateSnapshot {
  distTags?: DistTagsManifest;
  manifest?: BundleManifest;
  packageFiles: Set<string>;
}

export interface WriteDownloadRunHistoryOptions {
  before: BundleStateSnapshot;
  bundleDir: string;
  pruneReport?: BundlePruneReport;
  rangeResolutionPolicy: RangeResolutionPolicy;
  report: CollectReport;
  tagResolutionPolicy: TagResolutionPolicy;
  workspaceSnapshot?: unknown;
}

export interface WritePublishRunHistoryOptions {
  bundleDir: string;
  report: ApplyBundleReport;
}

interface PreviousResolution {
  file: string;
  version: string;
}

interface ResolutionChange {
  name: string;
  raw: string;
  reason: string;
  requiredBy: string;
  specifier: string;
  to: string;
  type: FetchPackageAction['type'];
  from?: string;
  policy?: RangeResolutionPolicy | TagResolutionPolicy;
}

interface ResolutionChangesReport {
  added: ResolutionChange[];
  changed: ResolutionChange[];
  generatedAt: string;
  removed: {
    path: string;
    reason: string;
  }[];
  schemaVersion: 1;
}

interface PackageChange {
  file: string;
  id: string;
  name: string;
  resolvedFrom: BundleManifest['packages'][number]['resolvedFrom'];
  version: string;
}

interface PackageChangesReport {
  added: PackageChange[];
  generatedAt: string;
  removed: PackageChange[];
  schemaVersion: 1;
  summary: {
    added: number;
    after: number;
    before: number;
    removed: number;
  };
}

function runId(generatedAt: string): string {
  return generatedAt.replace(/[-:.]/gu, '').replace(/[^0-9TZ]/gu, '');
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }

  return fs.readJson<T>(filePath);
}

async function copyIfExists(source: string, target: string): Promise<void> {
  if (!(await fs.pathExists(source))) {
    return;
  }

  await fs.ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
}

async function readPackageFiles(bundleDir: string): Promise<Set<string>> {
  const packagesDir = path.join(bundleDir, 'packages');

  try {
    return new Set((await fs.readdir(packagesDir)).filter((entry) => entry.endsWith('.tgz')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
}

function packageId(name: string, version: string): string {
  return `${name}@${version}`;
}

function requirementKey(requirement: {
  name: string;
  requiredBy: string;
  specifier: string;
  type: string;
}): string {
  return [requirement.name, requirement.type, requirement.specifier, requirement.requiredBy].join(
    '\0'
  );
}

function previousResolutions(
  manifest: BundleManifest | undefined
): Map<string, PreviousResolution> {
  const resolutions = new Map<string, PreviousResolution>();

  for (const pkg of manifest?.packages ?? []) {
    for (const reason of pkg.resolvedFrom) {
      resolutions.set(requirementKey({ ...reason, name: pkg.name }), {
        file: pkg.file,
        version: pkg.version,
      });
    }
  }

  return resolutions;
}

function previousPackageIds(manifest: BundleManifest | undefined): Set<string> {
  return new Set((manifest?.packages ?? []).map((pkg) => packageId(pkg.name, pkg.version)));
}

function packageIdentity(pkg: BundleManifest['packages'][number]): string {
  return packageId(pkg.name, pkg.version);
}

function toPackageChange(pkg: BundleManifest['packages'][number]): PackageChange {
  return {
    file: pkg.file,
    id: packageIdentity(pkg),
    name: pkg.name,
    resolvedFrom: pkg.resolvedFrom,
    version: pkg.version,
  };
}

function createPackageChanges(
  before: BundleManifest | undefined,
  after: BundleManifest | undefined,
  generatedAt: string
): PackageChangesReport {
  const beforePackages = before?.packages ?? [];
  const afterPackages = after?.packages ?? [];
  const beforeIds = new Set(beforePackages.map(packageIdentity));
  const afterIds = new Set(afterPackages.map(packageIdentity));
  const added = afterPackages
    .filter((pkg) => !beforeIds.has(packageIdentity(pkg)))
    .map(toPackageChange);
  const removed = beforePackages
    .filter((pkg) => !afterIds.has(packageIdentity(pkg)))
    .map(toPackageChange);

  return {
    added,
    generatedAt,
    removed,
    schemaVersion: 1,
    summary: {
      added: added.length,
      after: afterPackages.length,
      before: beforePackages.length,
      removed: removed.length,
    },
  };
}

function policyForRequirement(
  requirement: FetchPackageAction,
  options: Pick<WriteDownloadRunHistoryOptions, 'rangeResolutionPolicy' | 'tagResolutionPolicy'>
): RangeResolutionPolicy | TagResolutionPolicy | undefined {
  if (requirement.type === 'range') {
    return options.rangeResolutionPolicy;
  }

  if (requirement.type === 'tag') {
    return options.tagResolutionPolicy;
  }

  return undefined;
}

function changeReason(
  requirement: FetchPackageAction,
  previous: PreviousResolution | undefined,
  before: BundleStateSnapshot,
  options: Pick<WriteDownloadRunHistoryOptions, 'rangeResolutionPolicy' | 'tagResolutionPolicy'>
): string {
  const policy = policyForRequirement(requirement, options);

  if (!previous) {
    return 'previous stable mapping was absent';
  }

  if (policy === 'refresh') {
    return 'resolution policy was refresh';
  }

  if (requirement.requiredBy === 'root') {
    return 'root requirement is always resolved from source registry';
  }

  if (!before.packageFiles.has(path.basename(previous.file))) {
    return 'previous mapped tarball was missing before download';
  }

  if (!previousPackageIds(before.manifest).has(requirement.requiredBy)) {
    return 'declaring parent package was not stable in previous bundle';
  }

  return 'resolved from source registry';
}

function toResolutionChange(
  requirement: FetchPackageAction,
  reason: string,
  policy: RangeResolutionPolicy | TagResolutionPolicy | undefined,
  previous?: PreviousResolution
): ResolutionChange {
  return {
    ...(previous ? { from: previous.version } : {}),
    name: requirement.name,
    ...(policy ? { policy } : {}),
    raw: requirement.raw,
    reason,
    requiredBy: requirement.requiredBy,
    specifier: requirement.specifier,
    to: requirement.version,
    type: requirement.type,
  };
}

function createResolutionChanges(
  before: BundleStateSnapshot,
  after: BundleManifest | undefined,
  generatedAt: string,
  pruneReport: BundlePruneReport | undefined,
  options: Pick<WriteDownloadRunHistoryOptions, 'rangeResolutionPolicy' | 'tagResolutionPolicy'>
): ResolutionChangesReport {
  const previous = previousResolutions(before.manifest);
  const changed: ResolutionChange[] = [];
  const added: ResolutionChange[] = [];

  for (const pkg of after?.packages ?? []) {
    for (const requirement of pkg.resolvedFrom) {
      const resolvedRequirement: FetchPackageAction = {
        ...requirement,
        file: pkg.file,
        name: pkg.name,
        resolvedVia: requirement.type === 'alias' ? 'version' : requirement.type,
        version: pkg.version,
      };
      const previousResolution = previous.get(requirementKey(resolvedRequirement));

      if (previousResolution?.version === resolvedRequirement.version) {
        continue;
      }

      const reason = changeReason(resolvedRequirement, previousResolution, before, options);
      const change = toResolutionChange(
        resolvedRequirement,
        reason,
        policyForRequirement(resolvedRequirement, options),
        previousResolution
      );

      if (previousResolution) {
        changed.push(change);
      } else {
        added.push(change);
      }
    }
  }

  return {
    added,
    changed,
    generatedAt,
    removed: (pruneReport?.actions ?? [])
      .filter((action) => action.type === 'npm-package' && action.status === 'removed')
      .map((action) => ({
        path: action.path,
        reason: 'pruned after no remaining parent in current seed-manifest',
      })),
    schemaVersion: 1,
  };
}

export async function captureBundleState(bundleDir: string): Promise<BundleStateSnapshot> {
  const [manifest, distTags, packageFiles] = await Promise.all([
    readOptionalJson<BundleManifest>(path.join(bundleDir, 'seed-manifest.json')),
    readOptionalJson<DistTagsManifest>(path.join(bundleDir, 'dist-tags.json')),
    readPackageFiles(bundleDir),
  ]);

  return {
    ...(distTags ? { distTags } : {}),
    ...(manifest ? { manifest } : {}),
    packageFiles,
  };
}

export async function writeDownloadRunHistory(
  options: WriteDownloadRunHistoryOptions
): Promise<string> {
  const targetDir = path.join(
    options.bundleDir,
    'runs',
    'download',
    runId(options.report.generatedAt)
  );
  const afterManifest = await readOptionalJson<BundleManifest>(
    path.join(options.bundleDir, 'seed-manifest.json')
  );
  const packageChanges = createPackageChanges(
    options.before.manifest,
    afterManifest,
    options.report.generatedAt
  );
  const changes = createResolutionChanges(
    options.before,
    afterManifest,
    options.report.generatedAt,
    options.pruneReport,
    {
      rangeResolutionPolicy: options.rangeResolutionPolicy,
      tagResolutionPolicy: options.tagResolutionPolicy,
    }
  );

  await fs.ensureDir(targetDir);
  if (options.before.manifest) {
    await fs.writeJson(path.join(targetDir, 'seed-manifest.before.json'), options.before.manifest, {
      spaces: 2,
    });
  }
  if (options.before.distTags) {
    await fs.writeJson(path.join(targetDir, 'dist-tags.before.json'), options.before.distTags, {
      spaces: 2,
    });
  }
  if (options.workspaceSnapshot) {
    await fs.writeJson(path.join(targetDir, 'workspace-snapshot.json'), options.workspaceSnapshot, {
      spaces: 2,
    });
  }

  await Promise.all([
    copyIfExists(
      path.join(options.bundleDir, 'seed-manifest.json'),
      path.join(targetDir, 'seed-manifest.after.json')
    ),
    copyIfExists(
      path.join(options.bundleDir, 'dist-tags.json'),
      path.join(targetDir, 'dist-tags.after.json')
    ),
    copyIfExists(
      path.join(options.bundleDir, 'fetch-report.json'),
      path.join(targetDir, 'fetch-report.json')
    ),
    copyIfExists(
      path.join(options.bundleDir, 'collect-report.json'),
      path.join(targetDir, 'collect-report.json')
    ),
    copyIfExists(
      path.join(options.bundleDir, 'git-fetch-report.json'),
      path.join(targetDir, 'git-fetch-report.json')
    ),
    copyIfExists(
      path.join(options.bundleDir, 'prune-report.json'),
      path.join(targetDir, 'prune-report.json')
    ),
  ]);
  await fs.writeJson(path.join(targetDir, 'package-changes.json'), packageChanges, { spaces: 2 });
  await fs.writeJson(path.join(targetDir, 'resolution-changes.json'), changes, { spaces: 2 });

  return targetDir;
}

export async function writePublishRunHistory(
  options: WritePublishRunHistoryOptions
): Promise<string> {
  const targetDir = path.join(
    options.bundleDir,
    'runs',
    'publish',
    runId(options.report.generatedAt)
  );

  await Promise.all(
    [
      'publish-report.json',
      'publish-dry-run-report.json',
      'gitea-repos-report.json',
      'git-apply-report.json',
      'git-config-report.json',
      'apply-report.json',
      'apply-dry-run-report.json',
    ].map((fileName) =>
      copyIfExists(path.join(options.bundleDir, fileName), path.join(targetDir, fileName))
    )
  );

  return targetDir;
}
