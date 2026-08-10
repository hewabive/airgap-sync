import path from 'node:path';
import type { Stats } from 'node:fs';
import { Transform } from 'node:stream';
import * as fs from './fs.js';
import * as tar from 'tar';
import type { PackageManifest, ResolvedRootPackage } from '../types.js';
import { semanticDigest } from './canonical-json.js';
import { packageFileName } from './files.js';
import {
  downloadResumableHttpFile,
  type ResumableDownloadProgressEvent,
  type ResumableDownloadRetryEvent,
} from './resumable-download.js';
import {
  computeFileDigests,
  createFileDigestCollector,
  fileDigestAlgorithmsKey,
  verifyComputedPackageIntegrity,
  type FileDigests,
  type PackageIntegrityExpectation,
} from './integrity.js';

export const tarballInspectionCacheFileName = 'npm-tarball-inspection-cache.json';

export interface PersistedTarballInspection {
  manifest: PackageManifest;
  manifestSha256: string;
}

export interface TarballInspectionCacheManifest {
  schemaVersion: 1;
  createdAt: string;
  inspections: Record<string, PersistedTarballInspection>;
}

export interface TarballInspection {
  digests: FileDigests;
  manifest: PackageManifest;
}

interface CachedTarballInspection {
  fingerprint: string;
  promise: Promise<TarballInspection>;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== 'string')) return undefined;
  return Object.fromEntries(entries);
}

function peerDependenciesMeta(value: unknown): Record<string, { optional?: boolean }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, { optional?: boolean }> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const optional = (item as { optional?: unknown }).optional;
    if (optional !== undefined && typeof optional !== 'boolean') return undefined;
    result[name] = optional === undefined ? {} : { optional };
  }
  return result;
}

function normalizePackageManifest(value: unknown): PackageManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.name !== 'string' ||
    candidate.name.length === 0 ||
    typeof candidate.version !== 'string' ||
    candidate.version.length === 0
  ) {
    return undefined;
  }

  const dependencies = stringRecord(candidate.dependencies);
  const devDependencies = stringRecord(candidate.devDependencies);
  const optionalDependencies = stringRecord(candidate.optionalDependencies);
  const peerDependencies = stringRecord(candidate.peerDependencies);
  const peerMeta = peerDependenciesMeta(candidate.peerDependenciesMeta);
  const scripts = stringRecord(candidate.scripts);
  if (
    (candidate.dependencies !== undefined && !dependencies) ||
    (candidate.devDependencies !== undefined && !devDependencies) ||
    (candidate.optionalDependencies !== undefined && !optionalDependencies) ||
    (candidate.peerDependencies !== undefined && !peerDependencies) ||
    (candidate.peerDependenciesMeta !== undefined && !peerMeta) ||
    (candidate.scripts !== undefined && !scripts)
  ) {
    return undefined;
  }
  return {
    name: candidate.name,
    version: candidate.version,
    ...(dependencies ? { dependencies } : {}),
    ...(devDependencies ? { devDependencies } : {}),
    ...(optionalDependencies ? { optionalDependencies } : {}),
    ...(peerDependencies ? { peerDependencies } : {}),
    ...(peerMeta ? { peerDependenciesMeta: peerMeta } : {}),
    ...(scripts ? { scripts } : {}),
  };
}

function clonePackageManifest(manifest: PackageManifest): PackageManifest {
  return normalizePackageManifest(manifest)!;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function statFingerprint(stat: Stats): string {
  return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':');
}

async function inspectPackageTarballUncached(
  tarballPath: string,
  expected: PackageIntegrityExpectation
): Promise<TarballInspection> {
  const collector = createFileDigestCollector(expected);
  let manifest: PackageManifest | undefined;
  const parser = new tar.Parser({
    onReadEntry(entry) {
      const pathParts = entry.path.split('/');
      if (pathParts.length !== 2 || pathParts[1] !== 'package.json') {
        entry.resume();
        return;
      }

      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      entry.on('end', () => {
        try {
          if (manifest) throw new Error(`Tarball contains multiple package.json files`);
          manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PackageManifest;
        } catch (error) {
          parser.abort(error as Error);
        }
      });
    },
  });
  const input = fs.createReadStream(tarballPath);
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      collector.update(chunk);
      callback(null, chunk);
    },
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      input.destroy();
      hashingStream.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    parser.on('error', fail);
    parser.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    input.on('error', fail);
    hashingStream.on('error', fail);
    input.pipe(hashingStream).pipe(parser);
  });

  const digests = collector.digest();
  if (!manifest?.name || !manifest.version) {
    verifyComputedPackageIntegrity(digests, expected, tarballPath);
    throw new Error(`Could not read package.json from ${tarballPath}`);
  }
  return { digests, manifest };
}

export class TarballInspectionCache {
  readonly #entries = new Map<string, CachedTarballInspection>();
  readonly #persisted = new Map<string, PackageManifest>();
  #hits = 0;
  #misses = 0;
  #persistentHits = 0;
  #persistentWrites = 0;

  constructor(manifest?: TarballInspectionCacheManifest) {
    if (manifest?.schemaVersion !== 1) return;
    for (const [sha256, inspection] of Object.entries(manifest.inspections)) {
      const packageManifest = normalizePackageManifest(inspection.manifest);
      if (
        isSha256(sha256) &&
        packageManifest &&
        inspection.manifestSha256 === semanticDigest(packageManifest)
      ) {
        this.#persisted.set(sha256, packageManifest);
      }
    }
  }

  get hits(): number {
    return this.#hits;
  }

  get misses(): number {
    return this.#misses;
  }

  get persistentHits(): number {
    return this.#persistentHits;
  }

  get persistentWrites(): number {
    return this.#persistentWrites;
  }

  toManifest(createdAt = new Date().toISOString()): TarballInspectionCacheManifest {
    return {
      schemaVersion: 1,
      createdAt,
      inspections: Object.fromEntries(
        [...this.#persisted.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sha256, manifest]) => {
            const cloned = clonePackageManifest(manifest);
            return [sha256, { manifest: cloned, manifestSha256: semanticDigest(cloned) }];
          })
      ),
    };
  }

  invalidate(tarballPath: string): void {
    const keyPrefix = `${path.resolve(tarballPath)}\0`;
    for (const key of this.#entries.keys()) {
      if (key.startsWith(keyPrefix)) this.#entries.delete(key);
    }
  }

  async inspect(
    tarballPath: string,
    expected: PackageIntegrityExpectation = {}
  ): Promise<TarballInspection> {
    const resolvedPath = path.resolve(tarballPath);
    const beforeFingerprint = statFingerprint(await fs.stat(resolvedPath));
    const key = `${resolvedPath}\0${fileDigestAlgorithmsKey(expected)}`;
    const cached = this.#entries.get(key);
    if (cached?.fingerprint === beforeFingerprint) {
      this.#hits++;
      const inspection = await cached.promise;
      verifyComputedPackageIntegrity(inspection.digests, expected, resolvedPath);
      return inspection;
    }

    this.#misses++;
    const persistedManifest = expected.sha256
      ? this.#persisted.get(expected.sha256.toLowerCase())
      : undefined;
    const promise = (
      persistedManifest
        ? computeFileDigests(resolvedPath, expected).then((digests) => {
            this.#persistentHits++;
            return { digests, manifest: clonePackageManifest(persistedManifest) };
          })
        : inspectPackageTarballUncached(resolvedPath, expected).then((inspection) => {
            verifyComputedPackageIntegrity(inspection.digests, expected, resolvedPath);
            const packageManifest = normalizePackageManifest(inspection.manifest);
            if (packageManifest && !this.#persisted.has(inspection.digests.sha256)) {
              this.#persisted.set(inspection.digests.sha256, packageManifest);
              this.#persistentWrites++;
            }
            return inspection;
          })
    ).then(async (inspection) => {
      const afterFingerprint = statFingerprint(await fs.stat(resolvedPath));
      if (afterFingerprint !== beforeFingerprint) {
        throw new Error(`Tarball changed while it was being inspected: ${resolvedPath}`);
      }
      return inspection;
    });
    this.#entries.set(key, { fingerprint: beforeFingerprint, promise });
    const inspection = await promise;
    verifyComputedPackageIntegrity(inspection.digests, expected, resolvedPath);
    return inspection;
  }
}

export async function inspectPackageTarball(
  tarballPath: string,
  expected: PackageIntegrityExpectation = {},
  cache?: TarballInspectionCache
): Promise<TarballInspection> {
  if (cache) return cache.inspect(tarballPath, expected);
  const inspection = await inspectPackageTarballUncached(tarballPath, expected);
  verifyComputedPackageIntegrity(inspection.digests, expected, tarballPath);
  return inspection;
}

export async function readTarballInspectionCache(
  bundleDir: string
): Promise<TarballInspectionCache> {
  const filePath = path.join(bundleDir, tarballInspectionCacheFileName);
  if (!(await fs.pathExists(filePath))) return new TarballInspectionCache();
  try {
    return new TarballInspectionCache(await fs.readJson<TarballInspectionCacheManifest>(filePath));
  } catch {
    return new TarballInspectionCache();
  }
}

export async function writeTarballInspectionCache(
  bundleDir: string,
  cache: TarballInspectionCache,
  createdAt = new Date().toISOString()
): Promise<void> {
  await fs.writeJsonAtomic(
    path.join(bundleDir, tarballInspectionCacheFileName),
    cache.toManifest(createdAt),
    { spaces: 2 }
  );
}

export interface DownloadedTarball {
  file: string;
  name: string;
  path: string;
  skipped: boolean;
  sha256: string;
  version: string;
}

export interface DownloadResolvedPackageOptions {
  existingSha256?: string;
  existingPackageFiles?: Set<string>;
  inspectionCache?: TarballInspectionCache;
  onProgress?: (event: ResumableDownloadProgressEvent) => void;
  onRetry?: (event: ResumableDownloadRetryEvent) => void;
  retryDelaysMs?: number[];
  timeoutMs?: number;
}

export async function downloadResolvedPackage(
  pkg: ResolvedRootPackage,
  outputDir: string,
  options: DownloadResolvedPackageOptions = {}
): Promise<DownloadedTarball> {
  const file = packageFileName(pkg.name, pkg.version);
  const packageDir = path.join(outputDir, 'packages');
  const outputPath = path.join(packageDir, file);

  const knownPackageFiles = options.existingPackageFiles;
  const alreadyExists = knownPackageFiles
    ? knownPackageFiles.has(file)
    : await fs.pathExists(outputPath);

  if (alreadyExists) {
    try {
      const inspection = await inspectPackageTarball(
        outputPath,
        {
          ...pkg.dist,
          ...(options.existingSha256 ? { sha256: options.existingSha256 } : {}),
        },
        options.inspectionCache
      );
      return {
        file: path.posix.join('packages', file),
        name: pkg.name,
        path: outputPath,
        skipped: true,
        sha256: inspection.digests.sha256,
        version: pkg.version,
      };
    } catch {
      options.inspectionCache?.invalidate(outputPath);
      await fs.remove(outputPath);
      knownPackageFiles?.delete(file);
    }
  }

  await fs.ensureDir(packageDir);
  options.inspectionCache?.invalidate(outputPath);
  await downloadResumableHttpFile({
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    ...(options.timeoutMs ? { stallTimeoutMs: options.timeoutMs } : {}),
    targetPath: outputPath,
    url: pkg.dist.tarball,
  });
  let sha256: string;
  try {
    options.inspectionCache?.invalidate(outputPath);
    sha256 = (await inspectPackageTarball(outputPath, pkg.dist, options.inspectionCache)).digests
      .sha256;
  } catch (error) {
    options.inspectionCache?.invalidate(outputPath);
    await fs.remove(outputPath);
    throw error;
  }
  knownPackageFiles?.add(file);

  return {
    file: path.posix.join('packages', file),
    name: pkg.name,
    path: outputPath,
    skipped: false,
    sha256,
    version: pkg.version,
  };
}

export async function readPackageManifest(tarballPath: string): Promise<PackageManifest> {
  return (await inspectPackageTarball(tarballPath)).manifest;
}

export function dependencySpecsFromManifest(
  manifest: PackageManifest,
  options: { includePeer?: boolean } = {}
): Record<string, string> {
  const peerDependencies =
    options.includePeer === true
      ? Object.fromEntries(
          Object.entries(manifest.peerDependencies ?? {}).filter(
            ([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true
          )
        )
      : {};

  return {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...peerDependencies,
  };
}
