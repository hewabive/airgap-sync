import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { semanticDigest } from '../canonical-json.js';
import * as fs from '../fs.js';
import {
  pythonApplicationIndexPath,
  pythonApplicationPlanDirectory,
  pythonApplicationPlanPath,
  pythonOptionalArtifactsDirectory,
  pythonWheelArtifactsDirectory,
} from './application-paths.js';
import type { ActivePythonApplicationPlan } from './active-plan-store.js';
import {
  createPythonEnvironmentPlan,
  serializePythonEnvironmentPlan,
  type PythonEnvironmentPlan,
  type PythonPlanTransferArtifact,
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
import type { PythonTargetEnvironmentConfig } from './environments.js';
import {
  createPythonConsumerLocks,
  createPythonRequirementsLock,
  type PythonConsumerLock,
} from './consumer-contract.js';

export type PythonApplicationArtifactKind = 'cpython' | 'license' | 'uv' | 'wheel';

export interface PythonApplicationArtifactReference {
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
  targetId: string;
}

export interface PythonApplicationBundleIndex {
  applications: PythonApplicationBundleEntry[];
  artifacts: PythonApplicationBundleArtifact[];
  createdAt: string;
  schemaVersion: 2;
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
  | 'reused'
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
  reused: number;
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
  dryRun?: boolean;
  fetch?: typeof globalThis.fetch;
  generatedAt?: string;
  onProgress?: (event: PythonApplicationDownloadProgressEvent) => void;
  partial?: boolean;
  targets: {
    activePlan: ActivePythonApplicationPlan;
    targetId: string;
  }[];
}

export interface VerifyPythonApplicationBundleResult {
  applications: number;
  artifacts: number;
  errors: string[];
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

function optionalArtifactFile(artifact: PythonPlanTransferArtifact): string {
  const kindDirectory =
    artifact.kind === 'cpython'
      ? 'runtimes'
      : path.posix.join('tools', artifact.kind === 'uv' ? 'uv' : 'licenses');
  return path.posix.join(
    pythonOptionalArtifactsDirectory,
    kindDirectory,
    artifact.sha256,
    safeFilename(artifact.filename)
  );
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
  fetchImplementation: typeof globalThis.fetch,
  onProgress?: (bytes: number, totalBytes?: number) => void
): Promise<number> {
  const temporary = `${targetPath}.${String(process.pid)}.download.tmp`;
  await fs.ensureDir(path.dirname(targetPath));
  await fs.remove(temporary);
  const hash = createHash('sha256');
  let size = 0;
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.byteLength;
      onProgress?.(size, artifact.expectedSize);
      callback(null, chunk);
    },
  });
  try {
    const url = new URL(artifact.sourceUrl);
    if (url.username || url.password) {
      throw new Error('Python application artifact URLs must not contain credentials');
    }
    onProgress?.(0, artifact.expectedSize);
    if (url.protocol === 'file:') {
      await pipeline(
        fs.createReadStream(fileURLToPath(url)),
        hashingStream,
        fs.createWriteStream(temporary)
      );
    } else if (url.protocol === 'http:' || url.protocol === 'https:') {
      const response = await fetchImplementation(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`artifact download failed with HTTP ${String(response.status)}`);
      }
      await pipeline(
        Readable.fromWeb(response.body),
        hashingStream,
        fs.createWriteStream(temporary)
      );
    } else {
      throw new Error(`Unsupported Python application artifact URL: ${url.toString()}`);
    }
    const digest = hash.digest('hex');
    if (digest !== artifact.sha256) {
      throw new Error(`SHA-256 mismatch: expected ${artifact.sha256}, received ${digest}`);
    }
    if (artifact.expectedSize !== undefined && artifact.expectedSize !== size) {
      throw new Error(
        `size mismatch: expected ${String(artifact.expectedSize)}, received ${String(size)}`
      );
    }
    await fs.rename(temporary, targetPath);
    return size;
  } finally {
    await fs.remove(temporary);
  }
}

async function reuseLegacyWheel(
  bundleDir: string,
  artifact: PlannedArtifact['artifact'],
  targetPath: string,
  onProgress?: (bytes: number) => void
): Promise<boolean> {
  if (artifact.kind !== 'wheel') {
    return false;
  }
  const legacyPath = path.join(bundleDir, 'python-packages', artifact.filename);
  if (!(await fs.pathExists(legacyPath))) {
    return false;
  }
  const actual = await hashFile(legacyPath, onProgress);
  if (
    actual.sha256 !== artifact.sha256 ||
    (artifact.expectedSize !== undefined && actual.size !== artifact.expectedSize)
  ) {
    return false;
  }
  await fs.ensureDir(path.dirname(targetPath));
  await fs.remove(targetPath);
  try {
    await fs.link(legacyPath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') {
      throw error;
    }
    await fs.copyFile(legacyPath, targetPath);
  }
  return true;
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
        { platforms: [...wheel.platforms], targetId }
      );
    }
    for (const runtime of activePlan.plan.runtimeArtifacts ?? []) {
      const id = artifactId(runtime.sha256, runtime.filename);
      addArtifact(
        artifacts,
        {
          file: optionalArtifactFile(runtime),
          filename: runtime.filename,
          id,
          kind: runtime.kind,
          sha256: runtime.sha256,
          ...(runtime.size !== undefined ? { expectedSize: runtime.size } : {}),
          sourceUrl: runtime.sourceUrl,
          version: runtime.version,
        },
        { platforms: [...runtime.platforms], targetId }
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
  if (
    (index as { schemaVersion?: unknown }).schemaVersion !== 2 ||
    !Array.isArray(index.applications) ||
    !Array.isArray(index.artifacts)
  ) {
    if ((index as { schemaVersion?: unknown }).schemaVersion === 1) {
      if (replaceLegacy) {
        return undefined;
      }
      throw new Error(
        'Python application bundle schemaVersion 1 is obsolete; run airgap-sync download again'
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
    const branchArtifacts = [...artifacts.values()].filter((artifact) =>
      artifact.references.some(
        (reference) =>
          reference.targetId === targetId && reference.platforms.includes(platform.platformFamilyId)
      )
    );
    return {
      artifactCount: branchArtifacts.length,
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
  const applications = [
    ...(replaceAll
      ? []
      : (current?.applications ?? []).filter((entry) => !selectedTargetIds.has(entry.targetId))),
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
    schemaVersion: 2,
    summary: {
      applications: applications.length,
      artifacts: artifacts.length,
      totalBytes: artifacts.reduce((total, artifact) => total + artifact.size, 0),
    },
  };
}

function environmentName(platformFamilyId: string, pythonMinor: string): string {
  return `${platformFamilyId}--py${pythonMinor.replace('.', '')}`;
}

function targetEnvironment(
  branch: PythonApplicationBundleBranchSize,
  plan: PythonEnvironmentPlan | undefined
): PythonTargetEnvironmentConfig {
  if (branch.platformFamilyId === 'windows-x86_64') {
    return {
      arch: 'x86_64',
      name: environmentName(branch.platformFamilyId, branch.pythonMinor),
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
    name: environmentName(branch.platformFamilyId, branch.pythonMinor),
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
  const previousApplicationRoots = new Set(
    (existing?.packages ?? [])
      .filter((pkg) =>
        pkg.files.some((file) => file.file.startsWith(`${pythonWheelArtifactsDirectory}/`))
      )
      .map((pkg) => `${pkg.name}==${pkg.version}`)
  );
  const packages = new Map<string, PythonSeedPackage>();
  for (const pkg of existing?.packages ?? []) {
    const legacyFiles = pkg.files.filter(
      (file) => !file.file.startsWith(`${pythonWheelArtifactsDirectory}/`)
    );
    if (legacyFiles.length > 0) {
      packages.set(`${pkg.name}\0${pkg.version}`, { ...pkg, files: legacyFiles });
    }
  }
  for (const artifact of index.artifacts.filter((candidate) => candidate.kind === 'wheel')) {
    if (!artifact.package) {
      throw new Error(`Python wheel artifact has no package identity: ${artifact.id}`);
    }
    const packageName = artifact.package;
    const metadata = parseCoreMetadata(
      await readWheelMetadata(path.join(bundleDir, artifact.file))
    );
    const environments = [
      ...new Set(
        artifact.references.flatMap((reference) => {
          const application = index.applications.find(
            (candidate) => candidate.targetId === reference.targetId
          );
          return reference.platforms.map((platformFamilyId) => {
            const branch = application?.branchSizes.find(
              (candidate) => candidate.platformFamilyId === platformFamilyId
            );
            return environmentName(
              platformFamilyId,
              branch?.pythonMinor ??
                selectedPlans
                  .get(reference.targetId)
                  ?.platforms.find((platform) => platform.platformFamilyId === platformFamilyId)
                  ?.pythonMinor ??
                '3.0'
            );
          });
        })
      ),
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
      environments: reference.platforms.map((platformFamilyId) => {
        const application = index.applications.find(
          (candidate) => candidate.targetId === reference.targetId
        );
        const branch = application?.branchSizes.find(
          (candidate) => candidate.platformFamilyId === platformFamilyId
        );
        return environmentName(platformFamilyId, branch?.pythonMinor ?? '3.0');
      }),
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
  const targetEnvironments = new Map<string, PythonTargetEnvironmentConfig>(
    (existing?.targetEnvironments ?? []).map((environment) => [environment.name, environment])
  );
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
    roots: [
      ...new Set([
        ...(existing?.roots ?? []),
        ...index.applications.map(
          (application) => `${application.application.name}==${application.application.version}`
        ),
      ]),
    ]
      .filter(
        (root) =>
          !previousApplicationRoots.has(root) ||
          index.applications.some(
            (application) =>
              root === `${application.application.name}==${application.application.version}`
          )
      )
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
  locks: PythonConsumerLock[],
  generatedAt: string
): Promise<void> {
  const directory = path.join(bundleDir, pythonApplicationPlanDirectory(targetId));
  const temporaryDirectory = `${directory}.tmp-${String(process.pid)}`;
  const backupDirectory = `${directory}.backup-${String(process.pid)}`;
  const prerequisiteReport: PythonPrerequisiteReport = createPythonPrerequisiteReport(
    activePlan.plan,
    generatedAt
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
  for (const [artifactIndex, planned] of orderedArtifacts.entries()) {
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
        current: artifactIndex,
        detail,
        status: 'progress',
        total: totalArtifacts,
        ...(totalBytes === undefined ? {} : { totalBytes }),
      });
    };
    options.onProgress?.({
      current: artifactIndex,
      detail: `inspect ${planned.artifact.filename}`,
      status: 'progress',
      total: totalArtifacts,
    });
    try {
      const existing = (await fs.pathExists(targetPath))
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
      } else if (
        !dryRun &&
        (await reuseLegacyWheel(bundleDir, planned.artifact, targetPath, (bytes) => {
          reportBytes(`reuse ${planned.artifact.filename}`, bytes, planned.artifact.expectedSize);
        }))
      ) {
        status = 'reused';
        size = (await fs.stat(targetPath)).size;
      } else if (dryRun) {
        status = 'would-download';
        size = planned.artifact.expectedSize ?? 0;
        incrementalIds.add(planned.artifact.id);
      } else {
        size = await downloadArtifact(
          planned.artifact,
          targetPath,
          options.fetch ?? globalThis.fetch,
          (bytes, totalBytes) => {
            reportBytes(`download ${planned.artifact.filename}`, bytes, totalBytes);
          }
        );
        status = 'downloaded';
        incrementalIds.add(planned.artifact.id);
      }
      downloadedArtifacts.set(planned.artifact.id, {
        ...planned.artifact,
        references: planned.references.sort((left, right) =>
          left.targetId.localeCompare(right.targetId)
        ),
        size,
      });
      actions.push({
        file: planned.artifact.file,
        id: planned.artifact.id,
        kind: planned.artifact.kind,
        size,
        status,
      });
      options.onProgress?.({
        current: artifactIndex + 1,
        detail: `${status} ${planned.artifact.filename}`,
        status: 'progress',
        total: totalArtifacts,
      });
    } catch (error) {
      const message = (error as Error).message;
      actions.push({
        error: message,
        file: planned.artifact.file,
        id: planned.artifact.id,
        kind: planned.artifact.kind,
        status: 'error',
      });
      options.onProgress?.({
        current: artifactIndex + 1,
        detail: `failed ${planned.artifact.filename}: ${message}`,
        status: 'progress',
        total: totalArtifacts,
      });
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
    .map(({ activePlan, targetId }) => {
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
        targetId,
      };
    })
    .filter((entry): entry is PythonApplicationBundleEntry => entry !== undefined)
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
  let index: PythonApplicationBundleIndex | undefined;
  let compatibilityManifest: PythonSeedManifest | undefined;
  if (!dryRun && actions.every((action) => action.status !== 'error')) {
    const current = await readCurrentIndex(bundleDir, true);
    index = mergeIndex(
      current,
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
    reused: actions.filter((action) => action.status === 'reused').length,
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
          writeApplicationDocuments(
            bundleDir,
            targetId,
            activePlan,
            consumerLocks.get(targetId)!,
            generatedAt
          )
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
      if (plan.planId !== application.planId) {
        errors.push(`Python application plan ID mismatch: ${application.targetId}`);
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
      }
    }
    try {
      const actual = await hashFile(path.join(resolvedBundleDir, artifact.file));
      if (actual.sha256 !== artifact.sha256) {
        errors.push(`Python application artifact SHA-256 mismatch: ${artifact.file}`);
      }
      if (actual.size !== artifact.size) {
        errors.push(`Python application artifact size mismatch: ${artifact.file}`);
      }
    } catch (error) {
      errors.push(
        `Python application artifact is missing or unreadable (${artifact.file}): ${(error as Error).message}`
      );
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
