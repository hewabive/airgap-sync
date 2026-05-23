import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as fs from './fs.js';
import * as tar from 'tar';
import type { PackageManifest, ResolvedRootPackage } from '../types.js';
import { packageFileName } from './files.js';
import { HttpStatusError, isRetryableFetchError, retry } from './retry.js';

export interface DownloadedTarball {
  file: string;
  name: string;
  path: string;
  skipped: boolean;
  version: string;
}

export async function downloadResolvedPackage(
  pkg: ResolvedRootPackage,
  outputDir: string
): Promise<DownloadedTarball> {
  const file = packageFileName(pkg.name, pkg.version);
  const packageDir = path.join(outputDir, 'packages');
  const outputPath = path.join(packageDir, file);

  if (await fs.pathExists(outputPath)) {
    return {
      file: path.posix.join('packages', file),
      name: pkg.name,
      path: outputPath,
      skipped: true,
      version: pkg.version,
    };
  }

  await fs.ensureDir(packageDir);

  await retry(
    async () => {
      const tarballResponse = await fetch(pkg.dist.tarball, {
        signal: AbortSignal.timeout(60_000),
      });

      if (tarballResponse.status !== 200) {
        throw new HttpStatusError(
          `Tarball download failed with status ${String(tarballResponse.status)}`,
          tarballResponse.status
        );
      }

      if (!tarballResponse.body) {
        throw new Error(`Tarball download returned an empty response body: ${pkg.dist.tarball}`);
      }

      try {
        await pipeline(Readable.fromWeb(tarballResponse.body), fs.createWriteStream(outputPath));
      } catch (error) {
        await fs.remove(outputPath);
        throw error;
      }
    },
    { isRetryable: isRetryableFetchError }
  );

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
