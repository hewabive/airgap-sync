import path from 'node:path';
import type {
  ApplyBundleReport,
  BundleManifest,
  BundlePruneReport,
  CollectReport,
  DistTagsManifest,
  FetchPackageAction,
  NpmSecurityReport,
  TagResolutionPolicy,
  RangeResolutionPolicy,
} from '../types.js';
import * as fs from './fs.js';
import {
  readPythonApplicationBundleIndex,
  type PythonApplicationBundleIndex,
} from './python/application-bundle.js';
import { pythonApplicationIndexPath } from './python/application-paths.js';
import {
  readCpythonDistributionBundleIndex,
  type CpythonDistributionBundleIndex,
} from './python/distribution-bundle.js';
import { pythonSecurityReportFileName, type PythonSecurityReport } from './python/security.js';
import type { NpmSecurityDeltaReport, PythonSecurityDeltaReport } from './security-delta.js';

export interface BundleStateSnapshot {
  cpythonDistributionIndex?: CpythonDistributionBundleIndex;
  distTags?: DistTagsManifest;
  manifest?: BundleManifest;
  npmSecurityReport?: NpmSecurityReport;
  packageFiles: Set<string>;
  pythonApplicationDocuments: {
    content: string;
    file: string;
  }[];
  pythonApplicationIndex?: PythonApplicationBundleIndex;
  pythonSecurityReport?: PythonSecurityReport;
}

export interface WriteDownloadRunHistoryOptions {
  before: BundleStateSnapshot;
  bundleDir: string;
  completedAt?: string;
  pruneReport?: BundlePruneReport;
  rangeResolutionPolicy: RangeResolutionPolicy;
  report: CollectReport;
  securityDeltas?: {
    npm?: NpmSecurityDeltaReport;
    python?: PythonSecurityDeltaReport;
  };
  scope?: DownloadRunScope;
  selectedTargetIndexes?: number[];
  tagResolutionPolicy: TagResolutionPolicy;
  workspaceSnapshot?: unknown;
}

export type DownloadRunScope = 'full' | 'partial';
export type DownloadRunStatus = 'failed' | 'success';

export interface DownloadRunRecord {
  completedAt: string;
  schemaVersion: 1;
  scope: DownloadRunScope;
  selectedTargetIndexes?: number[];
  startedAt: string;
  status: DownloadRunStatus;
}

export interface DownloadWindowGap {
  elapsedDays: number;
  elapsedMs: number;
  exceedsWindow: boolean;
  requiredWindowDays: number;
  windowDays: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeIsoTimestamp(value: unknown, description: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${description} must be an ISO timestamp`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${description} must be a normalized ISO timestamp`);
  }
  return value;
}

export function normalizeDownloadRunRecord(value: unknown): DownloadRunRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.scope !== 'full' && value.scope !== 'partial') ||
    (value.status !== 'success' && value.status !== 'failed')
  ) {
    throw new Error('Invalid download run record');
  }
  let selectedTargetIndexes: number[] | undefined;
  if (value.selectedTargetIndexes !== undefined) {
    if (
      !Array.isArray(value.selectedTargetIndexes) ||
      value.selectedTargetIndexes.some(
        (index) => !Number.isSafeInteger(index) || (index as number) <= 0
      )
    ) {
      throw new Error('Download run selectedTargetIndexes must contain positive integers');
    }
    selectedTargetIndexes = [...new Set(value.selectedTargetIndexes as number[])].sort(
      (left, right) => left - right
    );
  }
  if (value.scope === 'full' && selectedTargetIndexes !== undefined) {
    throw new Error('A full download run cannot select individual targets');
  }
  return {
    completedAt: normalizeIsoTimestamp(value.completedAt, 'Download run completedAt'),
    schemaVersion: 1,
    scope: value.scope,
    ...(selectedTargetIndexes ? { selectedTargetIndexes } : {}),
    startedAt: normalizeIsoTimestamp(value.startedAt, 'Download run startedAt'),
    status: value.status,
  };
}

export function downloadReportSucceeded(report: CollectReport): boolean {
  return (
    !report.dryRun &&
    report.wroteBundle &&
    report.fixedPoint &&
    report.repositoryUpdate.errors.length === 0 &&
    report.fetch.errors.length === 0 &&
    (report.pythonApplications?.errors.length ?? 0) === 0 &&
    (report.cpythonDistributions?.errors.length ?? 0) === 0 &&
    report.gitSources.skipped.length === 0 &&
    report.gitFetch.errors.length === 0 &&
    report.gitManifestScanErrors.length === 0 &&
    report.security?.ok !== false &&
    report.pythonSecurity?.ok !== false &&
    !report.maxIterationsReached
  );
}

export async function readLastSuccessfulFullDownload(
  bundleDir: string
): Promise<DownloadRunRecord | undefined> {
  const historyDir = path.join(bundleDir, 'runs', 'download');
  let entries;
  try {
    entries = await fs.readdir(historyDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const directory of directories) {
    const recordPath = path.join(historyDir, directory, 'run.json');
    if (!(await fs.pathExists(recordPath))) {
      continue;
    }
    try {
      const record = normalizeDownloadRunRecord(await fs.readJson(recordPath));
      if (record.status === 'success' && record.scope === 'full') {
        return record;
      }
    } catch {
      // Malformed or interrupted history entries are not successful watermarks.
    }
  }
  return undefined;
}

export function evaluateDownloadWindowGap(
  lastSuccessfulDownload: DownloadRunRecord,
  windowDays: number,
  now = new Date()
): DownloadWindowGap {
  if (!Number.isSafeInteger(windowDays) || windowDays <= 0) {
    throw new Error('Download windowDays must be a positive integer');
  }
  const elapsedMs = Math.max(
    0,
    now.getTime() - new Date(lastSuccessfulDownload.completedAt).getTime()
  );
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    elapsedDays: elapsedMs / dayMs,
    elapsedMs,
    exceedsWindow: elapsedMs > windowDays * dayMs,
    requiredWindowDays: Math.max(1, Math.ceil(elapsedMs / dayMs)),
    windowDays,
  };
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }

  return fs.readJson<T>(filePath);
}

async function readOptionalSuccessfulSecurityReport<T>(
  filePath: string,
  validate: (value: unknown) => value is T
): Promise<T | undefined> {
  try {
    const report = await readOptionalJson<unknown>(filePath);
    return validate(report) ? report : undefined;
  } catch {
    // A malformed active report cannot be used as a comparison baseline.
    return undefined;
  }
}

function isSuccessfulNpmSecurityReport(value: unknown): value is NpmSecurityReport {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.ok === true &&
    typeof value.generatedAt === 'string' &&
    Array.isArray(value.errors) &&
    value.errors.length === 0 &&
    Array.isArray(value.advisories) &&
    Array.isArray(value.staticFindings)
  );
}

function isSuccessfulPythonSecurityReport(value: unknown): value is PythonSecurityReport {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.ok === true &&
    typeof value.generatedAt === 'string' &&
    Array.isArray(value.errors) &&
    value.errors.length === 0 &&
    Array.isArray(value.advisories)
  );
}

async function readSecurityBaselineFromHistory<T>(options: {
  activeFileName: string;
  afterFileName: string;
  beforeFileName: string;
  bundleDir: string;
  failedFileName: string;
  validate: (value: unknown) => value is T;
}): Promise<T | undefined> {
  const historyDir = path.join(options.bundleDir, 'runs', 'download');
  let entries;
  try {
    entries = await fs.readdir(historyDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return readOptionalSuccessfulSecurityReport(
        path.join(options.bundleDir, options.activeFileName),
        options.validate
      );
    }
    throw error;
  }

  let historyHasSecurityEvidence = false;
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const directory of directories) {
    const runDir = path.join(historyDir, directory);
    const beforePath = path.join(runDir, options.beforeFileName);
    const afterPath = path.join(runDir, options.afterFileName);
    const failedPath = path.join(runDir, options.failedFileName);
    if (
      (await fs.pathExists(beforePath)) ||
      (await fs.pathExists(afterPath)) ||
      (await fs.pathExists(failedPath))
    ) {
      historyHasSecurityEvidence = true;
    }

    let record: DownloadRunRecord;
    try {
      record = normalizeDownloadRunRecord(await fs.readJson(path.join(runDir, 'run.json')));
    } catch {
      continue;
    }
    const candidatePaths = record.status === 'success' ? [afterPath, beforePath] : [beforePath];
    for (const candidatePath of candidatePaths) {
      const report = await readOptionalSuccessfulSecurityReport(candidatePath, options.validate);
      if (report) return report;
    }
  }

  if (historyHasSecurityEvidence) return undefined;
  return readOptionalSuccessfulSecurityReport(
    path.join(options.bundleDir, options.activeFileName),
    options.validate
  );
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

function pythonApplicationDocumentPaths(index: PythonApplicationBundleIndex): string[] {
  const files = new Set<string>();
  for (const application of index.applications) {
    const expectedDirectory = `python/applications/${application.targetId}/`;
    for (const file of [
      application.planPath,
      application.planDiffPath,
      application.prerequisiteReportPath,
      ...application.locks.map((lock) => lock.file),
    ]) {
      if (
        path.posix.isAbsolute(file) ||
        file.includes('\\') ||
        file.split('/').includes('..') ||
        !file.startsWith(expectedDirectory)
      ) {
        throw new Error(`Unsafe Python application history path: ${file}`);
      }
      files.add(file);
    }
  }
  return [...files].sort();
}

async function readPythonApplicationDocuments(
  bundleDir: string,
  index: PythonApplicationBundleIndex | undefined
): Promise<BundleStateSnapshot['pythonApplicationDocuments']> {
  const documents: BundleStateSnapshot['pythonApplicationDocuments'] = [];
  for (const file of index ? pythonApplicationDocumentPaths(index) : []) {
    const filePath = path.join(bundleDir, file);
    if (await fs.pathExists(filePath)) {
      documents.push({ content: await fs.readFile(filePath, 'utf8'), file });
    }
  }
  return documents;
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
  const [
    manifest,
    distTags,
    packageFiles,
    pythonApplicationIndex,
    cpythonDistributionIndex,
    npmSecurityReport,
    pythonSecurityReport,
  ] = await Promise.all([
    readOptionalJson<BundleManifest>(path.join(bundleDir, 'seed-manifest.json')),
    readOptionalJson<DistTagsManifest>(path.join(bundleDir, 'dist-tags.json')),
    readPackageFiles(bundleDir),
    readPythonApplicationBundleIndex(bundleDir, { obsolete: 'ignore' }),
    readCpythonDistributionBundleIndex(bundleDir),
    readSecurityBaselineFromHistory({
      activeFileName: 'security-report.json',
      afterFileName: 'security-report.after.json',
      beforeFileName: 'security-report.before.json',
      bundleDir,
      failedFileName: 'security-report.failed.json',
      validate: isSuccessfulNpmSecurityReport,
    }),
    readSecurityBaselineFromHistory({
      activeFileName: pythonSecurityReportFileName,
      afterFileName: 'python-security-report.after.json',
      beforeFileName: 'python-security-report.before.json',
      bundleDir,
      failedFileName: 'python-security-report.failed.json',
      validate: isSuccessfulPythonSecurityReport,
    }),
  ]);
  const pythonApplicationDocuments = await readPythonApplicationDocuments(
    bundleDir,
    pythonApplicationIndex
  );

  return {
    ...(cpythonDistributionIndex ? { cpythonDistributionIndex } : {}),
    ...(distTags ? { distTags } : {}),
    ...(manifest ? { manifest } : {}),
    ...(npmSecurityReport ? { npmSecurityReport } : {}),
    packageFiles,
    pythonApplicationDocuments,
    ...(pythonApplicationIndex ? { pythonApplicationIndex } : {}),
    ...(pythonSecurityReport ? { pythonSecurityReport } : {}),
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
  if (options.before.pythonApplicationIndex) {
    await fs.writeJson(
      path.join(targetDir, 'python-application-index.before.json'),
      options.before.pythonApplicationIndex,
      { spaces: 2 }
    );
  }
  if (options.before.cpythonDistributionIndex) {
    await fs.writeJson(
      path.join(targetDir, 'python-distributions-index.before.json'),
      options.before.cpythonDistributionIndex,
      { spaces: 2 }
    );
  }
  if (options.before.npmSecurityReport) {
    await fs.writeJson(
      path.join(targetDir, 'security-report.before.json'),
      options.before.npmSecurityReport,
      { spaces: 2 }
    );
  }
  if (options.before.pythonSecurityReport) {
    await fs.writeJson(
      path.join(targetDir, 'python-security-report.before.json'),
      options.before.pythonSecurityReport,
      { spaces: 2 }
    );
  }
  await Promise.all(
    options.before.pythonApplicationDocuments.map((document) =>
      fs.writeFileAtomic(
        path.join(targetDir, 'python-applications.before', document.file),
        document.content
      )
    )
  );
  if (options.workspaceSnapshot) {
    await fs.writeJson(path.join(targetDir, 'workspace-snapshot.json'), options.workspaceSnapshot, {
      spaces: 2,
    });
  }

  const reportCopies = [
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
      path.join(options.bundleDir, 'python-seed-manifest.json'),
      path.join(targetDir, 'python-seed-manifest.after.json')
    ),
    copyIfExists(
      path.join(options.bundleDir, pythonApplicationIndexPath),
      path.join(targetDir, 'python-application-index.after.json')
    ),
    copyIfExists(
      path.join(options.bundleDir, 'python-application-fetch-report.json'),
      path.join(targetDir, 'python-application-fetch-report.json')
    ),
    copyIfExists(
      path.join(options.bundleDir, 'python/distributions/index.json'),
      path.join(targetDir, 'python-distributions-index.after.json')
    ),
    copyIfExists(
      path.join(options.bundleDir, 'python/distributions/fetch-report.json'),
      path.join(targetDir, 'python-distributions-fetch-report.json')
    ),
  ];

  if (options.pruneReport) {
    reportCopies.push(
      copyIfExists(
        path.join(options.bundleDir, 'prune-report.json'),
        path.join(targetDir, 'prune-report.json')
      )
    );
  }

  await Promise.all(reportCopies);
  if (options.report.security) {
    await fs.writeJson(
      path.join(
        targetDir,
        options.report.security.ok ? 'security-report.after.json' : 'security-report.failed.json'
      ),
      options.report.security,
      { spaces: 2 }
    );
  }
  if (options.report.pythonSecurity) {
    await fs.writeJson(
      path.join(
        targetDir,
        options.report.pythonSecurity.ok
          ? 'python-security-report.after.json'
          : 'python-security-report.failed.json'
      ),
      options.report.pythonSecurity,
      { spaces: 2 }
    );
  }
  if (options.securityDeltas?.npm) {
    await fs.writeJson(path.join(targetDir, 'security-delta.json'), options.securityDeltas.npm, {
      spaces: 2,
    });
  }
  if (options.securityDeltas?.python) {
    await fs.writeJson(
      path.join(targetDir, 'python-security-delta.json'),
      options.securityDeltas.python,
      { spaces: 2 }
    );
  }
  const afterPythonApplicationIndex = await readPythonApplicationBundleIndex(options.bundleDir, {
    obsolete: 'ignore',
  });
  await Promise.all(
    (afterPythonApplicationIndex
      ? pythonApplicationDocumentPaths(afterPythonApplicationIndex)
      : []
    ).map((file) =>
      copyIfExists(
        path.join(options.bundleDir, file),
        path.join(targetDir, 'python-applications.after', file)
      )
    )
  );
  await fs.writeJson(path.join(targetDir, 'package-changes.json'), packageChanges, { spaces: 2 });
  await fs.writeJson(path.join(targetDir, 'resolution-changes.json'), changes, { spaces: 2 });
  const record = normalizeDownloadRunRecord({
    completedAt: options.completedAt ?? new Date().toISOString(),
    schemaVersion: 1,
    scope: options.scope ?? 'full',
    ...(options.selectedTargetIndexes
      ? { selectedTargetIndexes: options.selectedTargetIndexes }
      : {}),
    startedAt: options.report.generatedAt,
    status: downloadReportSucceeded(options.report) ? 'success' : 'failed',
  });
  await fs.writeJson(path.join(targetDir, 'run.json'), record, { spaces: 2 });

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
      'python-publish-report.json',
      'python-publish-dry-run-report.json',
      'python-application-publish-report.json',
      'python-application-publish-dry-run-report.json',
      'python/distributions/publish-report.json',
      'python/distributions/publish-dry-run-report.json',
    ].map((fileName) =>
      copyIfExists(path.join(options.bundleDir, fileName), path.join(targetDir, fileName))
    )
  );

  return targetDir;
}
