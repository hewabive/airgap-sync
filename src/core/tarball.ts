import path from 'node:path';
import * as fs from './fs.js';
import * as tar from 'tar';
import type { PackageManifest, ResolvedRootPackage } from '../types.js';
import { packageFileName } from './files.js';
import {
  downloadResumableHttpFile,
  type ResumableDownloadProgressEvent,
  type ResumableDownloadRetryEvent,
} from './resumable-download.js';

export interface DownloadedTarball {
  file: string;
  name: string;
  path: string;
  skipped: boolean;
  version: string;
}

export interface DownloadResolvedPackageOptions {
  existingPackageFiles?: Set<string>;
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
    return {
      file: path.posix.join('packages', file),
      name: pkg.name,
      path: outputPath,
      skipped: true,
      version: pkg.version,
    };
  }

  await fs.ensureDir(packageDir);
  await downloadResumableHttpFile({
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    ...(options.timeoutMs ? { stallTimeoutMs: options.timeoutMs } : {}),
    targetPath: outputPath,
    url: pkg.dist.tarball,
  });
  knownPackageFiles?.add(file);

  return {
    file: path.posix.join('packages', file),
    name: pkg.name,
    path: outputPath,
    skipped: false,
    version: pkg.version,
  };
}

export async function readPackageManifest(tarballPath: string): Promise<PackageManifest> {
  let manifest: PackageManifest | undefined;

  await tar.t({
    file: tarballPath,
    onentry: (entry) => {
      const pathParts = entry.path.split('/');
      if (pathParts.length !== 2 || pathParts[1] !== 'package.json') {
        return;
      }

      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on('end', () => {
        manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PackageManifest;
      });
    },
  });

  if (!manifest?.name || !manifest.version) {
    throw new Error(`Could not read package.json from ${tarballPath}`);
  }

  return manifest;
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
