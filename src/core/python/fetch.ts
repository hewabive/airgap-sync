import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as fs from '../fs.js';
import { HttpStatusError, isRetryableFetchError, retry } from '../retry.js';
import type { PythonTargetEnvironmentConfig } from './environments.js';
import type { UnsupportedPythonInput } from './input-types.js';
import { selectStrongHash } from './integrity.js';
import { normalizePackageName } from './names.js';
import { compareVersions } from './pep440.js';
import type { PythonMetadataCache, PythonCoreMetadata } from './metadata.js';
import { parseCoreMetadata } from './metadata.js';
import type { PythonResolutionResult, ResolvedPythonArtifact } from './resolution-types.js';
import { parseWheelFilename } from './wheels.js';
import { readWheelMetadata } from './wheel-metadata.js';
import {
  type PythonEnvironmentSummary,
  type PythonFetchAction,
  type PythonFetchError,
  type PythonFetchReport,
  type PythonSeedFile,
  type PythonSeedManifest,
  type PythonSeedPackage,
  type PythonSeedReason,
  resolutionErrors,
} from './bundle.js';

export interface FetchPythonBundleOptions {
  bundleDir: string;
  cache: PythonMetadataCache;
  dryRun?: boolean;
  generatedAt?: string;
  resolution: PythonResolutionResult;
  retryDelaysMs?: number[];
  roots?: string[];
  sourceIndex: string;
  targetEnvironments: PythonTargetEnvironmentConfig[];
  timeoutMs?: number;
  unsupported?: UnsupportedPythonInput[];
}

export interface FetchPythonBundleResult {
  manifest?: PythonSeedManifest;
  report: PythonFetchReport;
}

interface ArtifactGroup {
  artifacts: ResolvedPythonArtifact[];
  environments: string[];
  file: ResolvedPythonArtifact['file'];
  metadata?: PythonCoreMetadata;
  name: string;
  reasons: Map<
    string,
    { environments: Set<string>; reason: ResolvedPythonArtifact['reasons'][number] }
  >;
  version: string;
}

interface DownloadResult {
  sha256: string;
  size: number;
  status: 'downloaded' | 'skipped';
}

function artifactKey(artifact: ResolvedPythonArtifact): string {
  return [artifact.name, artifact.version, artifact.file.filename, artifact.file.url].join('\0');
}

function reasonKey(reason: ResolvedPythonArtifact['reasons'][number]): string {
  return [reason.type, reason.raw, reason.requiredBy, reason.sourcePath].join('\0');
}

function groupArtifacts(artifacts: ResolvedPythonArtifact[]): ArtifactGroup[] {
  const groups = new Map<string, ArtifactGroup>();
  for (const artifact of artifacts) {
    const key = artifactKey(artifact);
    let group = groups.get(key);
    if (!group) {
      group = {
        artifacts: [],
        environments: [],
        file: artifact.file,
        name: artifact.name,
        reasons: new Map(),
        version: artifact.version,
      };
      groups.set(key, group);
    }
    group.artifacts.push(artifact);
    if (!group.metadata && artifact.metadata) {
      group.metadata = artifact.metadata;
    }
    if (!group.environments.includes(artifact.environment)) {
      group.environments.push(artifact.environment);
      group.environments.sort();
    }
    for (const reason of artifact.reasons) {
      const key = reasonKey(reason);
      const existing = group.reasons.get(key) ?? { environments: new Set<string>(), reason };
      existing.environments.add(artifact.environment);
      group.reasons.set(key, existing);
    }
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      compareVersions(left.version, right.version) ||
      left.file.filename.localeCompare(right.file.filename)
  );
}

async function hashFile(
  filePath: string,
  algorithm: 'sha256' | 'sha384' | 'sha512'
): Promise<{ selected: string; sha256: string; size: number }> {
  const selectedHash = createHash(algorithm);
  const sha256Hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    selectedHash.update(buffer);
    sha256Hash.update(buffer);
    size += buffer.length;
  }
  return { selected: selectedHash.digest('hex'), sha256: sha256Hash.digest('hex'), size };
}

async function existingFile(
  targetPath: string,
  expected: NonNullable<ReturnType<typeof selectStrongHash>>,
  expectedSize: number | undefined
): Promise<DownloadResult | undefined> {
  if (!(await fs.pathExists(targetPath))) {
    return undefined;
  }
  const actual = await hashFile(targetPath, expected.algorithm);
  if (
    actual.selected !== expected.digest ||
    (expectedSize !== undefined && actual.size !== expectedSize)
  ) {
    return undefined;
  }
  return { sha256: actual.sha256, size: actual.size, status: 'skipped' };
}

async function downloadArtifact(
  group: ArtifactGroup,
  targetPath: string,
  options: Pick<FetchPythonBundleOptions, 'retryDelaysMs' | 'timeoutMs'>
): Promise<DownloadResult> {
  const expected = selectStrongHash(group.file.hashes);
  if (!expected) {
    throw new Error(`${group.file.filename} has no valid sha256-or-stronger source hash`);
  }
  const existing = await existingFile(targetPath, expected, group.file.size);
  if (existing) {
    return existing;
  }

  const packageDir = path.dirname(targetPath);
  await fs.ensureDir(packageDir);
  const tempDir = await fs.mkdtemp(path.join(packageDir, '.airgap-sync-python-'));
  const tempPath = path.join(tempDir, group.file.filename);
  try {
    const result = await retry(
      async (): Promise<DownloadResult> => {
        await fs.remove(tempPath);
        const response = await fetch(group.file.url, {
          signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
        });
        if (response.status !== 200) {
          throw new HttpStatusError(
            `Python wheel download failed with status ${String(response.status)}`,
            response.status
          );
        }
        if (!response.body) {
          throw new Error('Python wheel download returned an empty response body');
        }
        const selectedHash = createHash(expected.algorithm);
        const sha256Hash = createHash('sha256');
        let size = 0;
        const hashingStream = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            selectedHash.update(chunk);
            sha256Hash.update(chunk);
            size += chunk.length;
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body),
          hashingStream,
          fs.createWriteStream(tempPath)
        );
        const selectedDigest = selectedHash.digest('hex');
        if (selectedDigest !== expected.digest) {
          throw new Error(
            `${expected.algorithm} mismatch: expected ${expected.digest}, received ${selectedDigest}`
          );
        }
        if (group.file.size !== undefined && size !== group.file.size) {
          throw new Error(
            `size mismatch: expected ${String(group.file.size)}, received ${String(size)}`
          );
        }
        await fs.remove(targetPath);
        await fs.rename(tempPath, targetPath);
        return { sha256: sha256Hash.digest('hex'), size, status: 'downloaded' };
      },
      {
        ...(options.retryDelaysMs ? { delaysMs: options.retryDelaysMs } : {}),
        isRetryable: isRetryableFetchError,
      }
    );
    return result;
  } finally {
    await fs.remove(tempDir);
  }
}

function validateLocalMetadata(group: ArtifactGroup, metadata: PythonCoreMetadata): void {
  const wheel = parseWheelFilename(group.file.filename);
  if (wheel?.normalizedName !== normalizePackageName(metadata.name)) {
    throw new Error(`Wheel METADATA does not match ${group.file.filename}`);
  }
  if (compareVersions(wheel.version, metadata.version) !== 0) {
    throw new Error(`Wheel METADATA does not match ${group.file.filename}`);
  }
}

function seedReasons(group: ArtifactGroup): PythonSeedReason[] {
  return [...group.reasons.values()]
    .map(({ environments, reason }) => ({
      ...reason,
      environments: [...environments].sort(),
    }))
    .sort(
      (left, right) =>
        left.requiredBy.localeCompare(right.requiredBy) || left.raw.localeCompare(right.raw)
    );
}

function environmentTotals(
  groups: ArtifactGroup[],
  sizes: Map<string, number>,
  environments: PythonTargetEnvironmentConfig[]
): PythonEnvironmentSummary[] {
  return environments.map((environment) => {
    const matching = groups.filter((group) => group.environments.includes(environment.name));
    return {
      environment: environment.name,
      files: matching.length,
      packages: new Set(matching.map((group) => `${group.name}@${group.version}`)).size,
      size: matching.reduce(
        (total, group) => total + (sizes.get(artifactKey(group.artifacts[0]!)) ?? 0),
        0
      ),
    };
  });
}

export async function fetchPythonBundle(
  options: FetchPythonBundleOptions
): Promise<FetchPythonBundleResult> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const dryRun = options.dryRun === true;
  const groups = groupArtifacts(options.resolution.artifacts);
  const errors: PythonFetchError[] = resolutionErrors(options.resolution.errors);
  const actions: PythonFetchAction[] = [];
  const sizes = new Map<string, number>();
  const seedFiles = new Map<string, PythonSeedFile>();
  const filenames = new Map<string, string>();

  for (const group of groups) {
    const identity = artifactKey(group.artifacts[0]!);
    const previousIdentity = filenames.get(group.file.filename);
    if (previousIdentity && previousIdentity !== identity) {
      errors.push({
        file: group.file.filename,
        name: group.name,
        reason: 'Two different artifacts use the same bundle filename',
        stage: 'download',
      });
      continue;
    }
    filenames.set(group.file.filename, identity);
    const relativeFile = path.posix.join('python-packages', group.file.filename);
    if (dryRun) {
      actions.push({
        environments: group.environments,
        file: relativeFile,
        package: `${group.name}@${group.version}`,
        status: 'planned',
      });
      sizes.set(identity, group.file.size ?? 0);
      continue;
    }

    const targetPath = path.join(options.bundleDir, relativeFile);
    try {
      const download = await downloadArtifact(group, targetPath, options);
      let metadata = group.metadata;
      if (!metadata) {
        metadata = parseCoreMetadata(await readWheelMetadata(targetPath));
        validateLocalMetadata(group, metadata);
        options.cache.set(
          {
            hashes: group.file.hashes,
            sourceIndex: options.sourceIndex,
            url: group.file.url,
          },
          metadata
        );
      }
      sizes.set(identity, download.size);
      seedFiles.set(identity, {
        coreMetadata: metadata,
        environments: group.environments,
        file: relativeFile,
        filename: group.file.filename,
        kind: 'wheel',
        sha256: download.sha256,
        sourceHashes: group.file.hashes,
        url: group.file.url,
      });
      actions.push({
        environments: group.environments,
        file: relativeFile,
        package: `${group.name}@${group.version}`,
        status: download.status,
      });
    } catch (error) {
      const reason = (error as Error).message;
      errors.push({ file: group.file.filename, name: group.name, reason, stage: 'download' });
      actions.push({
        environments: group.environments,
        error: reason,
        file: relativeFile,
        package: `${group.name}@${group.version}`,
        status: 'error',
      });
    }
  }

  let manifest: PythonSeedManifest | undefined;
  if (!dryRun && errors.length === 0) {
    const packageGroups = new Map<string, ArtifactGroup[]>();
    for (const group of groups) {
      const key = `${group.name}@${group.version}`;
      const entries = packageGroups.get(key) ?? [];
      entries.push(group);
      packageGroups.set(key, entries);
    }
    const packages: PythonSeedPackage[] = [...packageGroups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, packageArtifacts]) => {
        const files = packageArtifacts.map(
          (group) => seedFiles.get(artifactKey(group.artifacts[0]!))!
        );
        const reasons = packageArtifacts.flatMap(seedReasons);
        const requiresPython = files.map((file) => file.coreMetadata.requiresPython).find(Boolean);
        return {
          files: files.sort((left, right) => left.filename.localeCompare(right.filename)),
          name: packageArtifacts[0]!.name,
          resolvedFrom: reasons,
          version: packageArtifacts[0]!.version,
          ...(requiresPython ? { requiresPython } : {}),
        };
      });
    manifest = {
      schemaVersion: 1,
      createdAt: generatedAt,
      packages,
      roots: [...new Set(options.roots ?? [])].sort(),
      sourceIndex: options.sourceIndex,
      targetEnvironments: options.targetEnvironments,
    };
  }

  const report: PythonFetchReport = {
    actions,
    approximate: options.resolution.approximate,
    downloaded: actions.filter((action) => action.status === 'downloaded').length,
    dryRun,
    enabled: true,
    environmentTotals: environmentTotals(groups, sizes, options.targetEnvironments),
    errors,
    generatedAt,
    planned: actions.filter((action) => action.status === 'planned').length,
    resolvedFiles: groups.length,
    resolvedPackages: new Set(groups.map((group) => `${group.name}@${group.version}`)).size,
    skipped: actions.filter((action) => action.status === 'skipped').length,
    sourceIndex: options.sourceIndex,
    unsupported: options.unsupported ?? [],
  };
  return { ...(manifest ? { manifest } : {}), report };
}
