import path from 'node:path';
import type { Readable } from 'node:stream';
import axios from 'axios';
import fs from 'fs-extra';
import type { ResolvedRootPackage } from '../types.js';
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

  const response = await axios.get<Readable>(pkg.dist.tarball, {
    responseType: 'stream',
    timeout: 60_000,
    validateStatus: (status) => status === 200,
  });

  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return {
    file: path.posix.join('packages', file),
    name: pkg.name,
    path: outputPath,
    skipped: false,
    version: pkg.version,
  };
}
