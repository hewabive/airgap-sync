import { createHash } from 'node:crypto';
import path from 'node:path';
import { mapConcurrent } from '../concurrency.js';
import * as fs from '../fs.js';
import {
  downloadResumableHttpFile,
  type ResumableDownloadRetryEvent,
} from '../resumable-download.js';
import type { WorkspaceCpythonDistributionsTarget } from '../workspace.js';
import {
  cpythonDistributionArtifactId,
  cpythonDistributionTargetId,
  selectCpythonDistributions,
  type CpythonDistributionCandidate,
  type CpythonDistributionTargetSelection,
  type SelectedCpythonDistribution,
} from './distribution-selection.js';
import {
  discoverCpythonDistributionCandidates,
  type CpythonDistributionDiscoveryRetryEvent,
} from './distribution-provider.js';

export const cpythonDistributionsDirectory = 'python/distributions';
export const cpythonDistributionArtifactsDirectory = `${cpythonDistributionsDirectory}/artifacts`;
export const cpythonDistributionIndexPath = `${cpythonDistributionsDirectory}/index.json`;
export const cpythonDistributionFetchReportPath = `${cpythonDistributionsDirectory}/fetch-report.json`;

export interface CpythonDistributionBundleArtifact extends SelectedCpythonDistribution {
  file: string;
}

export interface CpythonDistributionBundleIndex {
  artifacts: CpythonDistributionBundleArtifact[];
  createdAt: string;
  schemaVersion: 1;
  summary: {
    artifacts: number;
    bytes: number;
    targets: number;
  };
  targets: CpythonDistributionTargetSelection[];
}

export type CpythonDistributionDownloadStatus = 'downloaded' | 'error' | 'planned' | 'skipped';

export interface CpythonDistributionDownloadAction {
  error?: string;
  file: string;
  id: string;
  size: number;
  sourceUrl: string;
  status: CpythonDistributionDownloadStatus;
}

export interface CpythonDistributionDownloadReport {
  actions: CpythonDistributionDownloadAction[];
  discovered: number;
  downloaded: number;
  dryRun: boolean;
  errors: CpythonDistributionDownloadAction[];
  generatedAt: string;
  planned: number;
  selected: number;
  skipped: number;
}

export interface DownloadCpythonDistributionBundleOptions {
  bundleDir: string;
  candidates?: CpythonDistributionCandidate[];
  concurrency?: number;
  dryRun?: boolean;
  fetch?: typeof globalThis.fetch;
  generatedAt?: string;
  onDownloadProgress?: (event: {
    artifact: SelectedCpythonDistribution;
    downloadedBytes: number;
    totalBytes: number;
  }) => void;
  onDiscoveryPage?: (event: { candidates: number; page: number; releases: number }) => void;
  onDiscoveryRetry?: (event: CpythonDistributionDiscoveryRetryEvent) => void;
  onRetry?: (artifact: SelectedCpythonDistribution, event: ResumableDownloadRetryEvent) => void;
  partial?: boolean;
  requestTimeoutMs?: number;
  retryDelaysMs?: number[];
  stallTimeoutMs?: number;
  targets: WorkspaceCpythonDistributionsTarget[];
}

function artifactFile(artifact: SelectedCpythonDistribution): string {
  return path.posix.join(cpythonDistributionArtifactsDirectory, artifact.sha256, artifact.filename);
}

function safeBundleFile(bundleDir: string, relativeFile: string): string {
  if (
    path.posix.isAbsolute(relativeFile) ||
    relativeFile.includes('\\') ||
    relativeFile.split('/').includes('..') ||
    !relativeFile.startsWith(`${cpythonDistributionArtifactsDirectory}/`)
  ) {
    throw new Error(`Unsafe CPython distribution bundle path: ${relativeFile}`);
  }
  return path.join(bundleDir, relativeFile);
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return hash.digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeCpythonDistributionBundleIndex(
  value: unknown
): CpythonDistributionBundleIndex {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.createdAt !== 'string' ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.targets) ||
    !isRecord(value.summary)
  ) {
    throw new Error('Invalid CPython distribution bundle index');
  }
  const createdAt = new Date(value.createdAt);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) {
    throw new Error('Invalid CPython distribution bundle index timestamp');
  }
  const artifacts: CpythonDistributionBundleArtifact[] = [];
  const artifactIds = new Set<string>();
  for (const rawArtifact of value.artifacts) {
    if (
      !isRecord(rawArtifact) ||
      typeof rawArtifact.id !== 'string' ||
      artifactIds.has(rawArtifact.id) ||
      typeof rawArtifact.file !== 'string' ||
      typeof rawArtifact.filename !== 'string' ||
      rawArtifact.filename.includes('/') ||
      rawArtifact.filename.includes('\\') ||
      (rawArtifact.platformFamilyId !== 'linux-glibc-x86_64' &&
        rawArtifact.platformFamilyId !== 'windows-x86_64') ||
      rawArtifact.provider !== 'python-build-standalone' ||
      typeof rawArtifact.providerBuild !== 'string' ||
      !/^\d{8}$/u.test(rawArtifact.providerBuild) ||
      typeof rawArtifact.providerPublishedAt !== 'string' ||
      typeof rawArtifact.pythonVersion !== 'string' ||
      !/^\d+\.\d+\.\d+$/u.test(rawArtifact.pythonVersion) ||
      typeof rawArtifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(rawArtifact.sha256) ||
      typeof rawArtifact.size !== 'number' ||
      !Number.isSafeInteger(rawArtifact.size) ||
      rawArtifact.size <= 0 ||
      typeof rawArtifact.sourceUrl !== 'string' ||
      !Array.isArray(rawArtifact.references) ||
      !rawArtifact.references.every((reference) => typeof reference === 'string')
    ) {
      throw new Error('Invalid CPython distribution bundle artifact');
    }
    const artifact: CpythonDistributionBundleArtifact = {
      file: rawArtifact.file,
      filename: rawArtifact.filename,
      id: rawArtifact.id,
      platformFamilyId: rawArtifact.platformFamilyId,
      provider: rawArtifact.provider,
      providerBuild: rawArtifact.providerBuild,
      providerPublishedAt: rawArtifact.providerPublishedAt,
      pythonVersion: rawArtifact.pythonVersion,
      references: rawArtifact.references.filter(
        (reference): reference is string => typeof reference === 'string'
      ),
      sha256: rawArtifact.sha256,
      size: rawArtifact.size,
      sourceUrl: rawArtifact.sourceUrl,
    };
    const publishedAt = new Date(artifact.providerPublishedAt);
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(artifact.sourceUrl);
    } catch {
      throw new Error('Invalid CPython distribution bundle artifact URL');
    }
    if (
      !Number.isFinite(publishedAt.getTime()) ||
      publishedAt.toISOString() !== artifact.providerPublishedAt ||
      sourceUrl.protocol !== 'https:' ||
      sourceUrl.username ||
      sourceUrl.password ||
      artifact.file !== artifactFile(artifact) ||
      artifact.id !== cpythonDistributionArtifactId(artifact)
    ) {
      throw new Error('Invalid CPython distribution bundle artifact identity');
    }
    artifactIds.add(artifact.id);
    artifacts.push(artifact);
  }
  const targets: CpythonDistributionTargetSelection[] = [];
  const targetIds = new Set<string>();
  for (const rawSelection of value.targets) {
    if (
      !isRecord(rawSelection) ||
      typeof rawSelection.targetId !== 'string' ||
      targetIds.has(rawSelection.targetId) ||
      !Array.isArray(rawSelection.artifactIds) ||
      !rawSelection.artifactIds.every(
        (artifactId) => typeof artifactId === 'string' && artifactIds.has(artifactId)
      ) ||
      !isRecord(rawSelection.target) ||
      rawSelection.target.type !== 'cpython-distributions'
    ) {
      throw new Error('Invalid CPython distribution bundle target selection');
    }
    const target = rawSelection.target as unknown as WorkspaceCpythonDistributionsTarget;
    if (rawSelection.targetId !== cpythonDistributionTargetId(target)) {
      throw new Error('Invalid CPython distribution bundle target identity');
    }
    const selection: CpythonDistributionTargetSelection = {
      artifactIds: rawSelection.artifactIds.filter(
        (artifactId): artifactId is string => typeof artifactId === 'string'
      ),
      target,
      targetId: rawSelection.targetId,
    };
    targetIds.add(selection.targetId);
    targets.push(selection);
  }
  if (
    typeof value.summary.artifacts !== 'number' ||
    !Number.isSafeInteger(value.summary.artifacts) ||
    value.summary.artifacts !== artifacts.length ||
    typeof value.summary.bytes !== 'number' ||
    !Number.isSafeInteger(value.summary.bytes) ||
    value.summary.bytes !== artifacts.reduce((total, artifact) => total + artifact.size, 0) ||
    typeof value.summary.targets !== 'number' ||
    !Number.isSafeInteger(value.summary.targets) ||
    value.summary.targets !== targets.length ||
    artifacts.some((artifact) => artifact.references.some((reference) => !targetIds.has(reference)))
  ) {
    throw new Error('Invalid CPython distribution bundle index summary or references');
  }
  return {
    artifacts,
    createdAt: value.createdAt,
    schemaVersion: 1,
    summary: {
      artifacts: value.summary.artifacts,
      bytes: value.summary.bytes,
      targets: value.summary.targets,
    },
    targets,
  };
}

export async function readCpythonDistributionBundleIndex(
  bundleDir: string
): Promise<CpythonDistributionBundleIndex | undefined> {
  const indexPath = path.join(bundleDir, cpythonDistributionIndexPath);
  if (!(await fs.pathExists(indexPath))) return undefined;
  return normalizeCpythonDistributionBundleIndex(await fs.readJson(indexPath));
}

function mergePartialIndex(
  current: CpythonDistributionBundleIndex | undefined,
  next: CpythonDistributionBundleIndex
): CpythonDistributionBundleIndex {
  if (!current) return next;
  const artifacts = new Map(current.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const artifact of next.artifacts) artifacts.set(artifact.id, artifact);
  const targets = new Map(current.targets.map((target) => [target.targetId, target]));
  for (const target of next.targets) targets.set(target.targetId, target);
  const mergedArtifacts = [...artifacts.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const mergedTargets = [...targets.values()].sort((left, right) =>
    left.targetId.localeCompare(right.targetId)
  );
  return {
    artifacts: mergedArtifacts,
    createdAt: next.createdAt,
    schemaVersion: 1,
    summary: {
      artifacts: mergedArtifacts.length,
      bytes: mergedArtifacts.reduce((total, artifact) => total + artifact.size, 0),
      targets: mergedTargets.length,
    },
    targets: mergedTargets,
  };
}

async function existingArtifactIsReusable(
  bundleDir: string,
  artifact: CpythonDistributionBundleArtifact,
  current: CpythonDistributionBundleIndex | undefined
): Promise<boolean> {
  const recorded = current?.artifacts.find(
    (candidate) =>
      candidate.id === artifact.id &&
      candidate.file === artifact.file &&
      candidate.sha256 === artifact.sha256 &&
      candidate.size === artifact.size &&
      candidate.sourceUrl === artifact.sourceUrl
  );
  if (!recorded) return false;
  try {
    const file = safeBundleFile(bundleDir, artifact.file);
    return (
      (await fs.stat(file)).size === artifact.size && (await hashFile(file)) === artifact.sha256
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function downloadArtifact(
  artifact: CpythonDistributionBundleArtifact,
  options: DownloadCpythonDistributionBundleOptions
): Promise<CpythonDistributionDownloadAction> {
  const targetPath = safeBundleFile(options.bundleDir, artifact.file);
  if (options.dryRun === true) {
    return {
      file: artifact.file,
      id: artifact.id,
      size: artifact.size,
      sourceUrl: artifact.sourceUrl,
      status: 'planned',
    };
  }
  try {
    await downloadResumableHttpFile({
      expectedSize: artifact.size,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      onProgress: ({ downloadedBytes }) =>
        options.onDownloadProgress?.({
          artifact,
          downloadedBytes,
          totalBytes: artifact.size,
        }),
      ...(options.onRetry
        ? {
            onRetry: (event: ResumableDownloadRetryEvent) => {
              options.onRetry?.(artifact, event);
            },
          }
        : {}),
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      ...(options.stallTimeoutMs ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
      targetPath,
      url: new URL(artifact.sourceUrl),
      validateFile: async (file) => {
        const digest = await hashFile(file);
        if (digest !== artifact.sha256) {
          throw new Error(`SHA-256 mismatch: expected ${artifact.sha256}, received ${digest}`);
        }
      },
    });
    return {
      file: artifact.file,
      id: artifact.id,
      size: artifact.size,
      sourceUrl: artifact.sourceUrl,
      status: 'downloaded',
    };
  } catch (error) {
    return {
      error: (error as Error).message,
      file: artifact.file,
      id: artifact.id,
      size: artifact.size,
      sourceUrl: artifact.sourceUrl,
      status: 'error',
    };
  }
}

export async function downloadCpythonDistributionBundle(
  options: DownloadCpythonDistributionBundleOptions
): Promise<CpythonDistributionDownloadReport> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const candidates =
    options.candidates ??
    (await discoverCpythonDistributionCandidates({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      generatedAt,
      ...(options.onDiscoveryPage ? { onPage: options.onDiscoveryPage } : {}),
      ...(options.onDiscoveryRetry ? { onRetry: options.onDiscoveryRetry } : {}),
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      targets: options.targets,
    }));
  const selection = selectCpythonDistributions({
    candidates,
    generatedAt,
    targets: options.targets,
  });
  const current = await readCpythonDistributionBundleIndex(options.bundleDir);
  const artifacts = selection.artifacts.map<CpythonDistributionBundleArtifact>((artifact) => ({
    ...artifact,
    file: artifactFile(artifact),
  }));
  const actions = await mapConcurrent(
    artifacts,
    Math.max(1, options.concurrency ?? 4),
    async (artifact): Promise<CpythonDistributionDownloadAction> => {
      if (await existingArtifactIsReusable(options.bundleDir, artifact, current)) {
        return {
          file: artifact.file,
          id: artifact.id,
          size: artifact.size,
          sourceUrl: artifact.sourceUrl,
          status: 'skipped',
        };
      }
      return downloadArtifact(artifact, options);
    }
  );
  const errors = actions.filter((action) => action.status === 'error');
  const index: CpythonDistributionBundleIndex = {
    artifacts: artifacts.sort((left, right) => left.id.localeCompare(right.id)),
    createdAt: generatedAt,
    schemaVersion: 1,
    summary: {
      artifacts: artifacts.length,
      bytes: artifacts.reduce((total, artifact) => total + artifact.size, 0),
      targets: selection.targets.length,
    },
    targets: selection.targets,
  };
  if (options.dryRun !== true && errors.length === 0) {
    const activated = options.partial ? mergePartialIndex(current, index) : index;
    await fs.writeJsonAtomic(
      path.join(options.bundleDir, cpythonDistributionIndexPath),
      activated,
      {
        spaces: 2,
      }
    );
  }
  const report: CpythonDistributionDownloadReport = {
    actions,
    discovered: candidates.length,
    downloaded: actions.filter((action) => action.status === 'downloaded').length,
    dryRun: options.dryRun === true,
    errors,
    generatedAt,
    planned: actions.filter((action) => action.status === 'planned').length,
    selected: artifacts.length,
    skipped: actions.filter((action) => action.status === 'skipped').length,
  };
  if (options.dryRun !== true) {
    await fs.writeJsonAtomic(
      path.join(options.bundleDir, cpythonDistributionFetchReportPath),
      report,
      { spaces: 2 }
    );
  }
  return report;
}

export async function verifyCpythonDistributionBundle(bundleDir: string): Promise<string[]> {
  const index = await readCpythonDistributionBundleIndex(bundleDir);
  if (!index) return [];
  const errors: string[] = [];
  for (const artifact of index.artifacts) {
    let file: string;
    try {
      file = safeBundleFile(bundleDir, artifact.file);
    } catch (error) {
      errors.push((error as Error).message);
      continue;
    }
    if (!(await fs.pathExists(file))) {
      errors.push(`Missing CPython distribution artifact: ${artifact.file}`);
      continue;
    }
    const stat = await fs.stat(file);
    if (stat.size !== artifact.size) {
      errors.push(`CPython distribution size mismatch: ${artifact.file}`);
      continue;
    }
    if ((await hashFile(file)) !== artifact.sha256) {
      errors.push(`CPython distribution SHA-256 mismatch: ${artifact.file}`);
    }
  }
  return errors;
}
