import { createHash } from 'node:crypto';
import * as fs from './fs.js';

export interface ArtifactFileIntegrity {
  sha256: string;
  size: number;
}

export async function hashArtifactFile(
  filePath: string,
  onProgress?: (bytes: number) => void
): Promise<ArtifactFileIntegrity> {
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

export async function inspectIndexedArtifactFile(
  filePath: string,
  options: {
    indexed?: ArtifactFileIntegrity;
    onHashProgress?: (bytes: number) => void;
  } = {}
): Promise<ArtifactFileIntegrity | undefined> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isFile() && options.indexed?.size === stat.size) {
    return options.indexed;
  }
  return hashArtifactFile(filePath, options.onHashProgress);
}
