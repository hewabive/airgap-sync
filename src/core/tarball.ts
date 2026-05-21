import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'fs-extra';
import * as tar from 'tar';
import type { PackageManifest, ResolvedRootPackage } from '../types.js';
import { packageFileName } from './files.js';

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

  const response = await fetch(pkg.dist.tarball, {
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status !== 200) {
    throw new Error(`Tarball download failed with status ${String(response.status)}`);
  }

  if (!response.body) {
    throw new Error(`Tarball download returned an empty response body: ${pkg.dist.tarball}`);
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(outputPath));

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
  return {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...(options.includePeer ? manifest.peerDependencies : {}),
  };
}
