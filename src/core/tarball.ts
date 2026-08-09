import path from 'node:path';
import type { Stats } from 'node:fs';
import { Transform } from 'node:stream';
import * as fs from './fs.js';
import * as tar from 'tar';
import type { PackageManifest, ResolvedRootPackage } from '../types.js';
import { packageFileName } from './files.js';
import {
  downloadResumableHttpFile,
  type ResumableDownloadProgressEvent,
  type ResumableDownloadRetryEvent,
} from './resumable-download.js';
import {
  createFileDigestCollector,
  fileDigestAlgorithmsKey,
  verifyComputedPackageIntegrity,
  type FileDigests,
  type PackageIntegrityExpectation,
} from './integrity.js';

export interface TarballInspection {
  digests: FileDigests;
  manifest: PackageManifest;
}

interface CachedTarballInspection {
  fingerprint: string;
  promise: Promise<TarballInspection>;
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
  #hits = 0;
  #misses = 0;

  get hits(): number {
    return this.#hits;
  }

  get misses(): number {
    return this.#misses;
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
    const promise = inspectPackageTarballUncached(resolvedPath, expected).then(
      async (inspection) => {
        const afterFingerprint = statFingerprint(await fs.stat(resolvedPath));
        if (afterFingerprint !== beforeFingerprint) {
          throw new Error(`Tarball changed while it was being inspected: ${resolvedPath}`);
        }
        return inspection;
      }
    );
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

export interface DownloadedTarball {
  file: string;
  name: string;
  path: string;
  skipped: boolean;
  sha256: string;
  version: string;
}

export interface DownloadResolvedPackageOptions {
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
      const inspection = await inspectPackageTarball(outputPath, pkg.dist, options.inspectionCache);
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
