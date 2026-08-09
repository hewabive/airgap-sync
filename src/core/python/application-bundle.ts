import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { semanticDigest } from '../canonical-json.js';
import { mapConcurrent } from '../concurrency.js';
import * as fs from '../fs.js';
import {
  downloadResumableHttpFile,
  type ResumableDownloadRetryEvent,
} from '../resumable-download.js';
import {
  pythonApplicationIndexPath,
  pythonApplicationPlanDirectory,
  pythonApplicationPlanPath,
  pythonApplicationTargetId,
  pythonCompatibilityCellId,
  pythonWheelArtifactsDirectory,
} from './application-paths.js';
import type { ActivePythonApplicationPlan } from './active-plan-store.js';
import {
  createPythonEnvironmentPlan,
  serializePythonEnvironmentPlan,
  type PythonEnvironmentPlan,
  type PythonPlanWheel,
} from './environment-plan.js';
import {
  createPythonPrerequisiteReport,
  type PythonPrerequisiteReport,
} from './runtime-contract.js';
import {
  readPythonSeedManifest,
  type PythonSeedFile,
  type PythonSeedManifest,
  type PythonSeedPackage,
} from './bundle.js';
import { parseCoreMetadata } from './metadata.js';
import { readWheelMetadata } from './wheel-metadata.js';
import {
  resolveTargetEnvironment,
  wheelPriorityInEnvironment,
  type PythonTargetEnvironmentConfig,
} from './environments.js';
import { normalizePackageName } from './names.js';
import { compareVersions, versionSatisfies } from './pep440.js';
import { parseWheelFilename } from './wheels.js';
import {
  createPythonConsumerLocks,
  createPythonRequirementsLock,
  type PythonConsumerLock,
} from './consumer-contract.js';

export type PythonApplicationArtifactKind = 'wheel';

export interface PythonApplicationArtifactReference {
  cells: string[];
  platforms: string[];
  targetId: string;
}

export interface PythonApplicationBundleArtifact {
  file: string;
  filename: string;
  id: string;
  kind: PythonApplicationArtifactKind;
  package?: string;
  references: PythonApplicationArtifactReference[];
  sha256: string;
  size: number;
  sourceUrl: string;
  version: string;
}

export interface PythonApplicationBundleBranchSize {
  artifactCount: number;
  cellId: string;
  glibc?: string;
  incrementalBytes: number;
  platformFamilyId: string;
  pythonMinor: string;
  totalBytes: number;
}

export interface PythonApplicationBundleEntry {
  application: PythonEnvironmentPlan['application'];
  artifactIds: string[];
  branchSizes: PythonApplicationBundleBranchSize[];
  features: Record<string, string>;
  locks: {
    digest: string;
    file: string;
    format: 'pylock' | 'requirements';
    platformFamilyId: string;
    pythonMinor: string;
  }[];
  planId: string;
  planDiffPath: string;
  planPath: string;
  prerequisiteReportPath: string;
  selectionId?: string;
  targetId: string;
}

export interface PythonApplicationBundleIndex {
  applications: PythonApplicationBundleEntry[];
  artifacts: PythonApplicationBundleArtifact[];
  createdAt: string;
  schemaVersion: 3;
  summary: {
    applications: number;
    artifacts: number;
    totalBytes: number;
  };
}

export type PythonApplicationDownloadStatus =
  | 'downloaded'
  | 'error'
  | 'existing'
  | 'would-download';

export interface PythonApplicationDownloadAction {
  error?: string;
  file: string;
  id: string;
  kind: PythonApplicationArtifactKind;
  size?: number;
  status: PythonApplicationDownloadStatus;
}

export interface PythonApplicationDownloadReport {
  actions: PythonApplicationDownloadAction[];
  applications: PythonApplicationBundleEntry[];
  downloaded: number;
  dryRun: boolean;
  errors: PythonApplicationDownloadAction[];
  existing: number;
  generatedAt: string;
  incrementalBytes: number;
  planned: number;
  schemaVersion: 1;
  totalBytes: number;
}

export type PythonApplicationDownloadProgressStatus = 'start' | 'progress' | 'done' | 'error';

export interface PythonApplicationDownloadProgressEvent {
  bytes?: number;
  current: number;
  detail?: string;
  status: PythonApplicationDownloadProgressStatus;
  total: number;
  totalBytes?: number;
}

export interface DownloadPythonApplicationPlansOptions {
  bundleDir: string;
  concurrency?: number;
  dryRun?: boolean;
  fetch?: typeof globalThis.fetch;
  generatedAt?: string;
  onProgress?: (event: PythonApplicationDownloadProgressEvent) => void;
  partial?: boolean;
  requestTimeoutMs?: number;
  retryDelaysMs?: number[];
  stallTimeoutMs?: number;
  targets: {
    activePlan: ActivePythonApplicationPlan;
    selectionId?: string;
    targetId: string;
  }[];
  validateCandidate?: (candidate: {
    index: PythonApplicationBundleIndex;
    manifest: PythonSeedManifest;
  }) => Promise<void>;
}

export interface VerifyPythonApplicationBundleResult {
  applications: number;
  artifacts: number;
  errors: string[];
}

export function pythonApplicationManifestCoverageErrors(
  index: PythonApplicationBundleIndex,
  manifest: PythonSeedManifest
): string[] {
  const errors: string[] = [];
  for (const artifact of index.artifacts) {
    const packageName = artifact.package;
    if (!packageName) {
      errors.push(`Python application wheel has no package identity: ${artifact.file}`);
      continue;
    }
    const packageEntry = manifest.packages.find(
      (pkg) =>
        normalizePackageName(pkg.name) === normalizePackageName(packageName) &&
        pkg.version === artifact.version
    );
    const file = packageEntry?.files.find((candidate) => candidate.file === artifact.file);
    const fileMatches =
      file?.filename === artifact.filename &&
      file.sha256.toLowerCase() === artifact.sha256.toLowerCase();
    if (!fileMatches) {
      errors.push(
        `Python application wheel is absent from the security manifest: ${packageName}==${artifact.version} ${artifact.file}`
      );
    }
  }
  return errors;
}

interface PlannedArtifact {
  artifact: Omit<PythonApplicationBundleArtifact, 'references' | 'size'> & {
    expectedSize?: number;
  };
  references: PythonApplicationArtifactReference[];
}

function safeFilename(filename: string): string {
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    throw new Error(`Unsafe Python application artifact filename: ${filename}`);
  }
  return filename;
}

function artifactId(sha256: string, filename: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error(`Invalid Python application artifact SHA-256: ${filename}`);
  }
  return `${sha256}:${safeFilename(filename)}`;
}

function wheelArtifactFile(wheel: PythonPlanWheel): string {
  return path.posix.join(pythonWheelArtifactsDirectory, wheel.sha256, safeFilename(wheel.filename));
}

async function hashFile(
  filePath: string,
  onProgress?: (bytes: number) => void
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    hash.update(buffer);
    size += buffer.byteLength;
    onProgress?.(size);
  }
  return { sha256: hash.digest('hex'), size };
}

async function downloadArtifact(
  artifact: PlannedArtifact['artifact'],
  targetPath: string,
  options: Pick<
    DownloadPythonApplicationPlansOptions,
    'fetch' | 'requestTimeoutMs' | 'retryDelaysMs' | 'stallTimeoutMs'
  > & {
    onProgress?: (bytes: number, totalBytes?: number) => void;
    onRetry?: (event: ResumableDownloadRetryEvent) => void;
  }
): Promise<number> {
  const partialPath = `${targetPath}.download.partial`;
  await fs.ensureDir(path.dirname(targetPath));
  const url = new URL(artifact.sourceUrl);
  if (url.username || url.password) {
    throw new Error('Python application artifact URLs must not contain credentials');
  }
  const validateFile = async (filePath: string): Promise<void> => {
    const actual = await hashFile(filePath);
    if (actual.sha256 !== artifact.sha256) {
      throw new Error(`SHA-256 mismatch: expected ${artifact.sha256}, received ${actual.sha256}`);
    }
    if (artifact.expectedSize !== undefined && artifact.expectedSize !== actual.size) {
      throw new Error(
        `size mismatch: expected ${String(artifact.expectedSize)}, received ${String(actual.size)}`
      );
    }
  };
  options.onProgress?.(
    (await fs.pathExists(partialPath)) ? (await fs.stat(partialPath)).size : 0,
    artifact.expectedSize
  );
  if (url.protocol === 'file:') {
    await fs.copyFile(fileURLToPath(url), partialPath);
    try {
      await validateFile(partialPath);
    } catch (error) {
      await fs.remove(partialPath);
      throw error;
    }
    await fs.remove(targetPath);
    await fs.rename(partialPath, targetPath);
    return (await fs.stat(targetPath)).size;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported Python application artifact URL: ${url.toString()}`);
  }
  const result = await downloadResumableHttpFile({
    ...(artifact.expectedSize === undefined ? {} : { expectedSize: artifact.expectedSize }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onProgress: ({ downloadedBytes, totalBytes }) =>
      options.onProgress?.(downloadedBytes, totalBytes),
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    partialPath,
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    ...(options.stallTimeoutMs ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
    targetPath,
    url,
    validateFile,
  });
  return result.size;
}

function addArtifact(
  artifacts: Map<string, PlannedArtifact>,
  artifact: PlannedArtifact['artifact'],
  reference: PythonApplicationArtifactReference
): void {
  const existing = artifacts.get(artifact.id);
  if (existing) {
    if (
      existing.artifact.sha256 !== artifact.sha256 ||
      existing.artifact.file !== artifact.file ||
      (existing.artifact.expectedSize !== undefined &&
        artifact.expectedSize !== undefined &&
        existing.artifact.expectedSize !== artifact.expectedSize)
    ) {
      throw new Error(`Conflicting Python artifact identity: ${artifact.id}`);
    }
    const existingReference = existing.references.find(
      (candidate) => candidate.targetId === reference.targetId
    );
    if (existingReference) {
      existingReference.cells = [
        ...new Set([...existingReference.cells, ...reference.cells]),
      ].sort();
      existingReference.platforms = [
        ...new Set([...existingReference.platforms, ...reference.platforms]),
      ].sort();
    } else {
      existing.references.push(reference);
    }
    return;
  }
  artifacts.set(artifact.id, { artifact, references: [reference] });
}

function collectPlannedArtifacts(
  targets: DownloadPythonApplicationPlansOptions['targets']
): Map<string, PlannedArtifact> {
  const artifacts = new Map<string, PlannedArtifact>();
  for (const { activePlan, targetId } of targets) {
    const planCell = (platform: PythonEnvironmentPlan['platforms'][number]): string =>
      pythonCompatibilityCellId(
        platform.platformFamilyId,
        platform.pythonMinor,
        platform.supportBoundary?.glibc
      );
    for (const wheel of activePlan.plan.wheels) {
      const id = artifactId(wheel.sha256, wheel.filename);
      addArtifact(
        artifacts,
        {
          file: wheelArtifactFile(wheel),
          filename: wheel.filename,
          id,
          kind: 'wheel',
          package: wheel.package,
          sha256: wheel.sha256,
          ...(wheel.size !== undefined ? { expectedSize: wheel.size } : {}),
          sourceUrl: wheel.url,
          version: wheel.version,
        },
        {
          cells: activePlan.plan.platforms
            .filter((platform) =>
              platform.packages.some(
                (pkg) =>
                  pkg.name === wheel.package &&
                  pkg.version === wheel.version &&
                  pkg.wheels.includes(wheel.filename)
              )
            )
            .map(planCell)
            .sort(),
          platforms: [...wheel.platforms],
          targetId,
        }
      );
    }
  }
  return artifacts;
}

async function readCurrentIndex(
  bundleDir: string,
  replaceLegacy = false
): Promise<PythonApplicationBundleIndex | undefined> {
  const filePath = path.join(bundleDir, pythonApplicationIndexPath);
  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }
  const index = await fs.readJson<PythonApplicationBundleIndex>(filePath);
  const hasObsoleteRuntimeArtifacts =
    Array.isArray(index.artifacts) &&
    index.artifacts.some((artifact) => (artifact as { kind?: unknown }).kind !== 'wheel');
  if (
    (index as { schemaVersion?: unknown }).schemaVersion !== 3 ||
    !Array.isArray(index.applications) ||
    !Array.isArray(index.artifacts) ||
    hasObsoleteRuntimeArtifacts
  ) {
    if (
      (index as { schemaVersion?: unknown }).schemaVersion === 1 ||
      (index as { schemaVersion?: unknown }).schemaVersion === 2 ||
      hasObsoleteRuntimeArtifacts
    ) {
      if (replaceLegacy) {
        return undefined;
      }
      throw new Error(
        'Python application bundle schemaVersion 1/2 or runtime-transfer artifacts are obsolete; run airgap-sync download again'
      );
    }
    throw new Error(`${pythonApplicationIndexPath} is invalid`);
  }
  return index;
}

function lockEntries(
  targetId: string,
  activePlan: ActivePythonApplicationPlan,
  locks: PythonConsumerLock[]
): PythonApplicationBundleEntry['locks'] {
  const applicationDirectory = pythonApplicationPlanDirectory(targetId);
  return [
    ...activePlan.manifest.evidence.map((evidence) => ({
      digest: evidence.digest,
      file: path.posix.join(applicationDirectory, evidence.path),
      format: 'pylock' as const,
      platformFamilyId: evidence.platformFamilyId,
      pythonMinor: evidence.pythonMinor,
    })),
    ...locks.map((lock) => ({
      digest: lock.digest,
      file: path.posix.join(applicationDirectory, lock.path),
      format: 'requirements' as const,
      platformFamilyId: lock.platformFamilyId,
      pythonMinor: lock.pythonMinor,
    })),
  ].sort(
    (left, right) =>
      left.platformFamilyId.localeCompare(right.platformFamilyId) ||
      left.format.localeCompare(right.format)
  );
}

function branchSizes(
  targetId: string,
  plan: PythonEnvironmentPlan,
  artifacts: Map<string, PythonApplicationBundleArtifact>,
  incrementalIds: Set<string>
): PythonApplicationBundleBranchSize[] {
  return plan.platforms.map((platform) => {
    const cellId = pythonCompatibilityCellId(
      platform.platformFamilyId,
      platform.pythonMinor,
      platform.supportBoundary?.glibc
    );
    const branchArtifacts = [...artifacts.values()].filter((artifact) =>
      artifact.references.some(
        (reference) => reference.targetId === targetId && reference.cells.includes(cellId)
      )
    );
    return {
      artifactCount: branchArtifacts.length,
      cellId,
      ...(platform.supportBoundary?.glibc ? { glibc: platform.supportBoundary.glibc } : {}),
      incrementalBytes: branchArtifacts
        .filter((artifact) => incrementalIds.has(artifact.id))
        .reduce((total, artifact) => total + artifact.size, 0),
      platformFamilyId: platform.platformFamilyId,
      pythonMinor: platform.pythonMinor,
      totalBytes: branchArtifacts.reduce((total, artifact) => total + artifact.size, 0),
    };
  });
}

function mergeIndex(
  current: PythonApplicationBundleIndex | undefined,
  selectedEntries: PythonApplicationBundleEntry[],
  selectedArtifacts: PythonApplicationBundleArtifact[],
  replaceAll: boolean,
  createdAt: string
): PythonApplicationBundleIndex {
  const selectedTargetIds = new Set(selectedEntries.map((entry) => entry.targetId));
  const selectedSelectionIds = new Set(
    selectedEntries.map((entry) => entry.selectionId ?? entry.targetId)
  );
  const applications = [
    ...(replaceAll
      ? []
      : (current?.applications ?? []).filter(
          (entry) => !selectedSelectionIds.has(entry.selectionId ?? entry.targetId)
        )),
    ...selectedEntries,
  ].sort((left, right) => left.targetId.localeCompare(right.targetId));
  const artifactsById = new Map(
    (current?.artifacts ?? []).map((artifact) => [artifact.id, artifact])
  );
  for (const artifact of selectedArtifacts) {
    const previous = artifactsById.get(artifact.id);
    artifactsById.set(
      artifact.id,
      previous && !replaceAll
        ? {
            ...artifact,
            references: [
              ...previous.references.filter(
                (reference) => !selectedTargetIds.has(reference.targetId)
              ),
              ...artifact.references,
            ].sort((left, right) => left.targetId.localeCompare(right.targetId)),
          }
        : artifact
    );
  }
  const liveArtifactIds = new Set(applications.flatMap((entry) => entry.artifactIds));
  const artifacts = [...artifactsById.values()]
    .filter((artifact) => liveArtifactIds.has(artifact.id))
    .map((artifact) => {
      const liveTargets = new Set(
        applications
          .filter((entry) => entry.artifactIds.includes(artifact.id))
          .map((entry) => entry.targetId)
      );
      return {
        ...artifact,
        references: artifact.references
          .filter((reference) => liveTargets.has(reference.targetId))
          .sort((left, right) => left.targetId.localeCompare(right.targetId)),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    applications,
    artifacts,
    createdAt,
    schemaVersion: 3,
    summary: {
      applications: applications.length,
      artifacts: artifacts.length,
      totalBytes: artifacts.reduce((total, artifact) => total + artifact.size, 0),
    },
  };
}

function targetEnvironment(
  branch: PythonApplicationBundleBranchSize,
  plan: PythonEnvironmentPlan | undefined
): PythonTargetEnvironmentConfig {
  if (branch.platformFamilyId === 'windows-x86_64') {
    return {
      arch: 'x86_64',
      name: branch.cellId,
      os: 'windows',
      pythonVersion: `${branch.pythonMinor}.0`,
    };
  }
  const glibc =
    branch.glibc ??
    plan?.platforms.find((platform) => platform.platformFamilyId === branch.platformFamilyId)
      ?.supportBoundary?.glibc ??
    '2.17';
  return {
    arch: 'x86_64',
    manylinux: `manylinux_${glibc.replace('.', '_')}`,
    name: branch.cellId,
    os: 'linux',
    pythonVersion: `${branch.pythonMinor}.0`,
  };
}

async function createPythonSeedCompatibilityManifest(
  bundleDir: string,
  index: PythonApplicationBundleIndex,
  selectedTargets: DownloadPythonApplicationPlansOptions['targets'],
  createdAt: string
): Promise<PythonSeedManifest> {
  const existingPath = path.join(bundleDir, 'python-seed-manifest.json');
  const existing = (await fs.pathExists(existingPath))
    ? await readPythonSeedManifest(bundleDir)
    : undefined;
  const selectedPlans = new Map(
    selectedTargets.map(({ activePlan, targetId }) => [targetId, activePlan.plan])
  );
  const previousApplicationFiles = new Map(
    (existing?.packages ?? []).flatMap((pkg) =>
      pkg.files
        .filter((file) => file.file.startsWith(`${pythonWheelArtifactsDirectory}/`))
        .map((file) => [file.file, file] as const)
    )
  );
  const packages = new Map<string, PythonSeedPackage>();
  for (const artifact of index.artifacts) {
    if (!artifact.package) {
      throw new Error(`Python wheel artifact has no package identity: ${artifact.id}`);
    }
    const packageName = artifact.package;
    const previousFile = previousApplicationFiles.get(artifact.file);
    const metadata =
      previousFile?.filename === artifact.filename &&
      previousFile.sha256 === artifact.sha256 &&
      previousFile.url === artifact.sourceUrl
        ? previousFile.coreMetadata
        : parseCoreMetadata(await readWheelMetadata(path.join(bundleDir, artifact.file)));
    const environments = [
      ...new Set(artifact.references.flatMap((reference) => reference.cells)),
    ].sort();
    const file: PythonSeedFile = {
      coreMetadata: metadata,
      environments,
      file: artifact.file,
      filename: artifact.filename,
      kind: 'wheel',
      sha256: artifact.sha256,
      sourceHashes: { sha256: artifact.sha256 },
      url: artifact.sourceUrl,
    };
    const key = `${artifact.package}\0${artifact.version}`;
    const current = packages.get(key);
    const resolvedFrom = artifact.references.map((reference) => ({
      environments: [...reference.cells],
      raw: `${packageName}==${artifact.version}`,
      requiredBy: `python-app:${reference.targetId}`,
      sourcePath:
        index.applications.find((application) => application.targetId === reference.targetId)
          ?.planPath ?? pythonApplicationIndexPath,
      type: 'target' as const,
    }));
    if (current) {
      if (
        !current.files.some(
          (candidate) => candidate.filename === file.filename && candidate.sha256 === file.sha256
        )
      ) {
        current.files.push(file);
      }
      current.files.sort((left, right) => left.filename.localeCompare(right.filename));
      current.resolvedFrom.push(...resolvedFrom);
    } else {
      packages.set(key, {
        files: [file],
        name: artifact.package,
        ...(metadata.requiresPython ? { requiresPython: metadata.requiresPython } : {}),
        resolvedFrom,
        version: artifact.version,
      });
    }
  }
  const targetEnvironments = new Map<string, PythonTargetEnvironmentConfig>();
  for (const application of index.applications) {
    const selectedPlan = selectedPlans.get(application.targetId);
    for (const branch of application.branchSizes) {
      const environment = targetEnvironment(branch, selectedPlan);
      targetEnvironments.set(environment.name, environment);
    }
  }
  return {
    createdAt,
    packages: [...packages.values()].sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
    ),
    roots: index.applications
      .map((application) => `${application.application.name}==${application.application.version}`)
      .sort(),
    schemaVersion: 1,
    sourceIndex:
      selectedTargets[0]?.activePlan.plan.intent.source.indexUrl ??
      existing?.sourceIndex ??
      'https://pypi.org/simple/',
    targetEnvironments: [...targetEnvironments.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

async function writeApplicationDocuments(
  bundleDir: string,
  targetId: string,
  activePlan: ActivePythonApplicationPlan,
  locks: PythonConsumerLock[]
): Promise<void> {
  const directory = path.join(bundleDir, pythonApplicationPlanDirectory(targetId));
  const temporaryDirectory = `${directory}.tmp-${String(process.pid)}`;
  const backupDirectory = `${directory}.backup-${String(process.pid)}`;
  const prerequisiteReport: PythonPrerequisiteReport = createPythonPrerequisiteReport(
    activePlan.plan
  );
  await fs.remove(temporaryDirectory);
  await fs.remove(backupDirectory);
  try {
    await Promise.all([
      fs.writeFileAtomic(
        path.join(temporaryDirectory, 'environment-plan.json'),
        serializePythonEnvironmentPlan(activePlan.plan)
      ),
      fs.writeJsonAtomic(path.join(temporaryDirectory, 'prerequisites.json'), prerequisiteReport, {
        spaces: 2,
      }),
      fs.writeJsonAtomic(path.join(temporaryDirectory, 'plan-diff.json'), activePlan.diff, {
        spaces: 2,
      }),
      ...locks.map((lock) =>
        fs.writeFileAtomic(path.join(temporaryDirectory, lock.path), lock.content)
      ),
      ...activePlan.manifest.evidence.map(async (evidence) => {
        const value = activePlan.evidence.find(
          (candidate) =>
            candidate.platformFamilyId === evidence.platformFamilyId &&
            candidate.pythonMinor === evidence.pythonMinor
        );
        if (!value) {
          throw new Error(`Missing active Python lock content: ${evidence.path}`);
        }
        await fs.writeFileAtomic(
          path.join(temporaryDirectory, evidence.path),
          value.pylock.content
        );
      }),
    ]);
    const hadPrevious = await fs.pathExists(directory);
    if (hadPrevious) {
      await fs.rename(directory, backupDirectory);
    }
    try {
      await fs.rename(temporaryDirectory, directory);
    } catch (error) {
      if (hadPrevious && (await fs.pathExists(backupDirectory))) {
        await fs.rename(backupDirectory, directory);
      }
      throw error;
    }
    await fs.remove(backupDirectory);
  } finally {
    await fs.remove(temporaryDirectory);
    await fs.remove(backupDirectory);
  }
}

export async function downloadPythonApplicationPlans(
  options: DownloadPythonApplicationPlansOptions
): Promise<PythonApplicationDownloadReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const dryRun = options.dryRun === true;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const currentIndex = await readCurrentIndex(bundleDir, true);
  const indexedArtifacts = new Map(
    (currentIndex?.artifacts ?? []).map((artifact) => [artifact.id, artifact])
  );
  const plannedArtifacts = collectPlannedArtifacts(options.targets);
  const orderedArtifacts = [...plannedArtifacts.values()].sort((left, right) =>
    left.artifact.id.localeCompare(right.artifact.id)
  );
  const totalArtifacts = orderedArtifacts.length;
  const actions: PythonApplicationDownloadAction[] = [];
  const downloadedArtifacts = new Map<string, PythonApplicationBundleArtifact>();
  const incrementalIds = new Set<string>();
  options.onProgress?.({
    current: 0,
    detail: `${String(options.targets.length)} application plans`,
    status: 'start',
    total: totalArtifacts,
  });
  let completed = 0;
  const artifactResults = await mapConcurrent(
    orderedArtifacts,
    options.concurrency,
    async (planned) => {
      const targetPath = path.join(bundleDir, planned.artifact.file);
      let lastByteDetail: string | undefined;
      let lastByteProgressAt = 0;
      const reportBytes = (detail: string, bytes: number, totalBytes?: number): void => {
        const now = Date.now();
        const detailChanged = detail !== lastByteDetail;
        const reachedEnd = totalBytes !== undefined && bytes === totalBytes;
        if (!detailChanged && !reachedEnd && now - lastByteProgressAt < 1_000) {
          return;
        }
        lastByteDetail = detail;
        lastByteProgressAt = now;
        options.onProgress?.({
          bytes,
          current: completed,
          detail,
          status: 'progress',
          total: totalArtifacts,
          ...(totalBytes === undefined ? {} : { totalBytes }),
        });
      };
      options.onProgress?.({
        current: completed,
        detail: `inspect ${planned.artifact.filename}`,
        status: 'progress',
        total: totalArtifacts,
      });
      let result:
        | {
            action: PythonApplicationDownloadAction;
            artifact: PythonApplicationBundleArtifact;
            incremental: boolean;
          }
        | { action: PythonApplicationDownloadAction };
      try {
        const indexed = indexedArtifacts.get(planned.artifact.id);
        const indexedMatch =
          indexed?.file === planned.artifact.file &&
          indexed.filename === planned.artifact.filename &&
          indexed.sha256 === planned.artifact.sha256 &&
          indexed.sourceUrl === planned.artifact.sourceUrl &&
          (planned.artifact.expectedSize === undefined ||
            indexed.size === planned.artifact.expectedSize);
        const indexedStat =
          indexedMatch && (await fs.pathExists(targetPath)) ? await fs.stat(targetPath) : undefined;
        const existing =
          indexed && indexedStat?.size === indexed.size
            ? { sha256: indexed.sha256, size: indexed.size }
            : (await fs.pathExists(targetPath))
              ? await hashFile(targetPath, (bytes) => {
                  reportBytes(
                    `verify ${planned.artifact.filename}`,
                    bytes,
                    planned.artifact.expectedSize
                  );
                })
              : undefined;
        const matches =
          existing?.sha256 === planned.artifact.sha256 &&
          (planned.artifact.expectedSize === undefined ||
            existing.size === planned.artifact.expectedSize);
        let status: PythonApplicationDownloadStatus;
        let size: number;
        if (matches) {
          status = 'existing';
          size = existing.size;
        } else if (dryRun) {
          status = 'would-download';
          size = planned.artifact.expectedSize ?? 0;
        } else {
          size = await downloadArtifact(planned.artifact, targetPath, {
            ...(options.fetch ? { fetch: options.fetch } : {}),
            onProgress: (bytes, totalBytes) => {
              reportBytes(`download ${planned.artifact.filename}`, bytes, totalBytes);
            },
            onRetry: ({ delayMs, downloadedBytes, error, nextAttempt, totalBytes }) => {
              const reason = error instanceof Error ? error.message : String(error);
              reportBytes(
                `retry ${planned.artifact.filename}: ${reason}; attempt ${String(nextAttempt)} in ${String(delayMs)}ms`,
                downloadedBytes,
                totalBytes
              );
            },
            ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
            ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
            ...(options.stallTimeoutMs ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
          });
          status = 'downloaded';
        }
        result = {
          action: {
            file: planned.artifact.file,
            id: planned.artifact.id,
            kind: planned.artifact.kind,
            size,
            status,
          },
          artifact: {
            ...planned.artifact,
            references: planned.references.sort((left, right) =>
              left.targetId.localeCompare(right.targetId)
            ),
            size,
          },
          incremental: status === 'downloaded' || status === 'would-download',
        };
      } catch (error) {
        const message = (error as Error).message;
        result = {
          action: {
            error: message,
            file: planned.artifact.file,
            id: planned.artifact.id,
            kind: planned.artifact.kind,
            status: 'error',
          },
        };
      }
      completed += 1;
      options.onProgress?.({
        current: completed,
        detail:
          result.action.status === 'error'
            ? `failed ${planned.artifact.filename}: ${result.action.error ?? 'unknown error'}`
            : `${result.action.status} ${planned.artifact.filename}`,
        status: 'progress',
        total: totalArtifacts,
      });
      return result;
    }
  );
  for (const result of artifactResults) {
    actions.push(result.action);
    if ('artifact' in result) {
      downloadedArtifacts.set(result.action.id, result.artifact);
      if (result.incremental) {
        incrementalIds.add(result.action.id);
      }
    }
  }
  options.onProgress?.({
    current: totalArtifacts,
    detail: 'prepare application bundle metadata',
    status: 'progress',
    total: totalArtifacts,
  });
  const consumerLocks = new Map<string, PythonConsumerLock[]>();
  for (const { activePlan, targetId } of options.targets) {
    try {
      consumerLocks.set(targetId, createPythonConsumerLocks(activePlan.plan));
    } catch (error) {
      actions.push({
        error: `could not generate consumer locks: ${(error as Error).message}`,
        file: pythonApplicationPlanDirectory(targetId),
        id: `consumer-contract:${targetId}`,
        kind: 'wheel',
        status: 'error',
      });
    }
  }
  const entries = options.targets
    .map(({ activePlan, selectionId, targetId }) => {
      const locks = consumerLocks.get(targetId);
      if (!locks) {
        return undefined;
      }
      const artifactIds = [...downloadedArtifacts.values()]
        .filter((artifact) =>
          artifact.references.some((reference) => reference.targetId === targetId)
        )
        .map((artifact) => artifact.id)
        .sort();
      return {
        application: activePlan.plan.application,
        artifactIds,
        branchSizes: branchSizes(targetId, activePlan.plan, downloadedArtifacts, incrementalIds),
        features: activePlan.plan.intent.application.features,
        locks: lockEntries(targetId, activePlan, locks),
        planId: activePlan.plan.planId,
        planDiffPath: path.posix.join(pythonApplicationPlanDirectory(targetId), 'plan-diff.json'),
        planPath: pythonApplicationPlanPath(targetId),
        prerequisiteReportPath: path.posix.join(
          pythonApplicationPlanDirectory(targetId),
          'prerequisites.json'
        ),
        ...(selectionId ? { selectionId } : {}),
        targetId,
      };
    })
    .filter((entry): entry is PythonApplicationBundleEntry => entry !== undefined)
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
  let index: PythonApplicationBundleIndex | undefined;
  let compatibilityManifest: PythonSeedManifest | undefined;
  if (!dryRun && actions.every((action) => action.status !== 'error')) {
    index = mergeIndex(
      currentIndex,
      entries,
      [...downloadedArtifacts.values()],
      options.partial !== true,
      generatedAt
    );
    try {
      compatibilityManifest = await createPythonSeedCompatibilityManifest(
        bundleDir,
        index,
        options.targets,
        generatedAt
      );
    } catch (error) {
      actions.push({
        error: `could not generate Gitea PyPI compatibility manifest: ${(error as Error).message}`,
        file: 'python-seed-manifest.json',
        id: 'python-seed-manifest',
        kind: 'wheel',
        status: 'error',
      });
    }
    if (compatibilityManifest && options.validateCandidate) {
      try {
        await options.validateCandidate({ index, manifest: compatibilityManifest });
      } catch (error) {
        actions.push({
          error: `Python security validation failed: ${(error as Error).message}`,
          file: 'python-security-report.failed.json',
          id: 'python-security',
          kind: 'wheel',
          status: 'error',
        });
      }
    }
  }
  const errors = actions.filter((action) => action.status === 'error');
  const report: PythonApplicationDownloadReport = {
    actions,
    applications: entries,
    downloaded: actions.filter((action) => action.status === 'downloaded').length,
    dryRun,
    errors,
    existing: actions.filter((action) => action.status === 'existing').length,
    generatedAt,
    incrementalBytes: [...downloadedArtifacts.values()]
      .filter((artifact) => incrementalIds.has(artifact.id))
      .reduce((total, artifact) => total + artifact.size, 0),
    planned: actions.filter((action) => action.status === 'would-download').length,
    schemaVersion: 1,
    totalBytes: [...downloadedArtifacts.values()].reduce(
      (total, artifact) => total + artifact.size,
      0
    ),
  };
  if (!dryRun) {
    if (errors.length === 0) {
      options.onProgress?.({
        current: totalArtifacts,
        detail: 'write application bundle metadata',
        status: 'progress',
        total: totalArtifacts,
      });
      await Promise.all(
        options.targets.map(({ activePlan, targetId }) =>
          writeApplicationDocuments(bundleDir, targetId, activePlan, consumerLocks.get(targetId)!)
        )
      );
      await Promise.all([
        fs.writeJsonAtomic(path.join(bundleDir, pythonApplicationIndexPath), index!, {
          spaces: 2,
        }),
        fs.writeJsonAtomic(
          path.join(bundleDir, 'python-seed-manifest.json'),
          compatibilityManifest!,
          { spaces: 2 }
        ),
      ]);
    }
    await fs.writeJsonAtomic(path.join(bundleDir, 'python-application-fetch-report.json'), report, {
      spaces: 2,
    });
  }
  options.onProgress?.({
    current: totalArtifacts,
    ...(errors.length === 0 ? {} : { detail: `${String(errors.length)} errors` }),
    status: errors.length === 0 ? 'done' : 'error',
    total: totalArtifacts,
  });
  return report;
}

export async function readPythonApplicationBundleIndex(
  bundleDir: string,
  options: { obsolete?: 'error' | 'ignore' } = {}
): Promise<PythonApplicationBundleIndex | undefined> {
  return readCurrentIndex(path.resolve(bundleDir), options.obsolete === 'ignore');
}

function safeBundleRelativePath(value: string): boolean {
  return (
    !path.posix.isAbsolute(value) &&
    !value.split(/[\\/]/u).includes('..') &&
    value === value.replace(/\\/gu, '/')
  );
}

export async function verifyPythonApplicationBundle(
  bundleDir: string
): Promise<VerifyPythonApplicationBundleResult> {
  const resolvedBundleDir = path.resolve(bundleDir);
  const errors: string[] = [];
  const index = await readCurrentIndex(resolvedBundleDir);
  if (!index) {
    return { applications: 0, artifacts: 0, errors };
  }
  const targetIds = new Set(index.applications.map((application) => application.targetId));
  const plansByTarget = new Map<string, PythonEnvironmentPlan>();
  for (const application of index.applications) {
    let environmentPlan: PythonEnvironmentPlan | undefined;
    if (
      application.planPath !== pythonApplicationPlanPath(application.targetId) ||
      !safeBundleRelativePath(application.planPath)
    ) {
      errors.push(`Unsafe or mismatched Python application plan path: ${application.planPath}`);
      continue;
    }
    try {
      const plan = createPythonEnvironmentPlan(
        await fs.readJson<PythonEnvironmentPlan>(path.join(resolvedBundleDir, application.planPath))
      );
      environmentPlan = plan;
      plansByTarget.set(application.targetId, plan);
      if (plan.planId !== application.planId) {
        errors.push(`Python application plan ID mismatch: ${application.targetId}`);
      }
      if (
        application.selectionId !== undefined &&
        application.selectionId !==
          pythonApplicationTargetId(plan.application.name, plan.coverage.policy.id)
      ) {
        errors.push(`Python application selection ID mismatch: ${application.targetId}`);
      }
    } catch (error) {
      errors.push(
        `Python application plan is missing or invalid (${application.targetId}): ${(error as Error).message}`
      );
    }
    for (const lock of application.locks) {
      if (!safeBundleRelativePath(lock.file)) {
        errors.push(`Unsafe Python application lock path: ${lock.file}`);
        continue;
      }
      try {
        const content = await fs.readFile(path.join(resolvedBundleDir, lock.file), 'utf8');
        if (semanticDigest(content) !== lock.digest) {
          errors.push(`Python application lock digest mismatch: ${lock.file}`);
        }
        if (lock.format === 'requirements' && environmentPlan) {
          const platform = environmentPlan.platforms.find(
            (candidate) =>
              candidate.platformFamilyId === lock.platformFamilyId &&
              candidate.pythonMinor === lock.pythonMinor
          );
          if (!platform || createPythonRequirementsLock(environmentPlan, platform) !== content) {
            errors.push(`Python requirements lock does not match its plan: ${lock.file}`);
          }
        }
      } catch (error) {
        errors.push(
          `Python application lock is missing or unreadable (${lock.file}): ${(error as Error).message}`
        );
      }
    }
    if (!safeBundleRelativePath(application.prerequisiteReportPath)) {
      errors.push(`Unsafe Python prerequisite report path: ${application.prerequisiteReportPath}`);
    } else {
      try {
        const prerequisite = await fs.readJson<PythonPrerequisiteReport>(
          path.join(resolvedBundleDir, application.prerequisiteReportPath)
        );
        if (prerequisite.planId !== application.planId) {
          errors.push(
            `Python prerequisite report plan ID mismatch: ${application.prerequisiteReportPath}`
          );
        }
      } catch (error) {
        errors.push(
          `Python prerequisite report is missing or invalid (${application.prerequisiteReportPath}): ${(error as Error).message}`
        );
      }
    }
    if (!safeBundleRelativePath(application.planDiffPath)) {
      errors.push(`Unsafe Python plan diff path: ${application.planDiffPath}`);
    } else {
      try {
        const diff = await fs.readJson<{ planId: { to: string }; schemaVersion: number }>(
          path.join(resolvedBundleDir, application.planDiffPath)
        );
        if (diff.schemaVersion !== 1 || diff.planId.to !== application.planId) {
          errors.push(`Python plan diff mismatch: ${application.planDiffPath}`);
        }
      } catch (error) {
        errors.push(
          `Python plan diff is missing or invalid (${application.planDiffPath}): ${(error as Error).message}`
        );
      }
    }
  }
  const artifactIds = new Set(index.artifacts.map((artifact) => artifact.id));
  const artifactMetadata = new Map<string, ReturnType<typeof parseCoreMetadata>>();
  for (const application of index.applications) {
    for (const id of application.artifactIds) {
      if (!artifactIds.has(id)) {
        errors.push(`Python application ${application.targetId} references missing artifact ${id}`);
      }
    }
  }
  for (const artifact of index.artifacts) {
    if (
      artifact.id !== artifactId(artifact.sha256, artifact.filename) ||
      !safeBundleRelativePath(artifact.file)
    ) {
      errors.push(`Invalid Python application artifact identity or path: ${artifact.id}`);
      continue;
    }
    for (const reference of artifact.references) {
      if (
        !Array.isArray(reference.cells) ||
        reference.cells.length === 0 ||
        !Array.isArray(reference.platforms) ||
        reference.platforms.length === 0
      ) {
        errors.push(`Python application artifact ${artifact.id} has an empty cell reference`);
        continue;
      }
      if (!targetIds.has(reference.targetId)) {
        errors.push(
          `Python application artifact ${artifact.id} references unknown target ${reference.targetId}`
        );
      } else if (
        !index.applications
          .find((application) => application.targetId === reference.targetId)
          ?.artifactIds.includes(artifact.id)
      ) {
        errors.push(
          `Python application artifact ${artifact.id} has an asymmetric reference to ${reference.targetId}`
        );
      } else {
        const application = index.applications.find(
          (candidate) => candidate.targetId === reference.targetId
        );
        const applicationCells = new Set(
          application?.branchSizes.map((branch) => branch.cellId) ?? []
        );
        for (const cell of reference.cells) {
          if (!applicationCells.has(cell)) {
            errors.push(
              `Python application artifact ${artifact.id} references unknown cell ${cell} for ${reference.targetId}`
            );
          }
        }
      }
    }
    try {
      const artifactPath = path.join(resolvedBundleDir, artifact.file);
      const actual = await hashFile(artifactPath);
      if (actual.sha256 !== artifact.sha256) {
        errors.push(`Python application artifact SHA-256 mismatch: ${artifact.file}`);
      }
      if (actual.size !== artifact.size) {
        errors.push(`Python application artifact size mismatch: ${artifact.file}`);
      }
      const metadata = parseCoreMetadata(await readWheelMetadata(artifactPath));
      artifactMetadata.set(artifact.id, metadata);
      if (
        !artifact.package ||
        normalizePackageName(metadata.name) !== normalizePackageName(artifact.package) ||
        compareVersions(metadata.version, artifact.version) !== 0
      ) {
        errors.push(`Python application wheel metadata identity mismatch: ${artifact.file}`);
      }
    } catch (error) {
      errors.push(
        `Python application artifact is missing or unreadable (${artifact.file}): ${(error as Error).message}`
      );
    }
  }
  for (const application of index.applications) {
    const plan = plansByTarget.get(application.targetId);
    if (!plan) {
      continue;
    }
    const expectedCells = new Set(
      plan.platforms.map((platform) =>
        pythonCompatibilityCellId(
          platform.platformFamilyId,
          platform.pythonMinor,
          platform.supportBoundary?.glibc
        )
      )
    );
    const indexedCells = new Set(application.branchSizes.map((branch) => branch.cellId));
    for (const cell of expectedCells) {
      if (!indexedCells.has(cell)) {
        errors.push(`Python application ${application.targetId} is missing branch ${cell}`);
      }
    }
    for (const cell of indexedCells) {
      if (!expectedCells.has(cell)) {
        errors.push(`Python application ${application.targetId} has unexpected branch ${cell}`);
      }
    }
    for (const platform of plan.platforms) {
      const cellId = pythonCompatibilityCellId(
        platform.platformFamilyId,
        platform.pythonMinor,
        platform.supportBoundary?.glibc
      );
      const branch = application.branchSizes.find((candidate) => candidate.cellId === cellId);
      if (!branch) {
        continue;
      }
      const environment = resolveTargetEnvironment(targetEnvironment(branch, plan));
      const packageNames = new Set(platform.packages.map((pkg) => normalizePackageName(pkg.name)));
      for (const pkg of platform.packages) {
        for (const dependency of pkg.dependencies) {
          if (!packageNames.has(normalizePackageName(dependency))) {
            errors.push(
              `Python application ${application.targetId} has an open dependency edge in ${cellId}: ${pkg.name}==${pkg.version} -> ${dependency}`
            );
          }
        }
        const wheels = index.artifacts.filter(
          (artifact) =>
            normalizePackageName(artifact.package ?? '') === normalizePackageName(pkg.name) &&
            artifact.version === pkg.version &&
            pkg.wheels.includes(artifact.filename) &&
            application.artifactIds.includes(artifact.id) &&
            artifact.references.some(
              (reference) =>
                reference.targetId === application.targetId && reference.cells.includes(cellId)
            )
        );
        if (wheels.length === 0) {
          errors.push(
            `Python application ${application.targetId} has no wheel for ${pkg.name}==${pkg.version} in ${cellId}`
          );
          continue;
        }
        if (
          !wheels.some((artifact) => {
            const wheel = parseWheelFilename(artifact.filename);
            const metadata = artifactMetadata.get(artifact.id);
            return (
              wheel !== undefined &&
              wheelPriorityInEnvironment(wheel, environment) !== undefined &&
              (!metadata?.requiresPython ||
                versionSatisfies(`${platform.pythonMinor}.0`, metadata.requiresPython))
            );
          })
        ) {
          errors.push(
            `Python application ${application.targetId} has no compatible wheel for ${pkg.name}==${pkg.version} in ${cellId}`
          );
        }
      }
    }
  }
  if (
    index.summary.applications !== index.applications.length ||
    index.summary.artifacts !== index.artifacts.length ||
    index.summary.totalBytes !==
      index.artifacts.reduce((total, artifact) => total + artifact.size, 0)
  ) {
    errors.push('Python application bundle index summary does not match its contents');
  }
  return {
    applications: index.applications.length,
    artifacts: index.artifacts.length,
    errors,
  };
}
