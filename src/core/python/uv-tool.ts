import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import * as tar from 'tar';
import * as yauzl from 'yauzl';
import manifestData from '../../../support/python/uv-tool-manifest.json' with { type: 'json' };
import * as fs from '../fs.js';
import {
  downloadResumableHttpFile,
  type ResumableDownloadRetryEvent,
} from '../resumable-download.js';

export interface UvToolAsset {
  file: string;
  sha256: string;
  size: number;
  url: string;
}

export interface UvToolManifest {
  assets: Record<string, UvToolAsset>;
  license: string;
  licenseFiles: {
    name: string;
    sha256: string;
    url: string;
  }[];
  name: 'uv';
  schemaVersion: 1;
  version: string;
}

export interface AcquireUvOptions {
  arch?: NodeJS.Architecture;
  cacheDir: string;
  fetch?: typeof globalThis.fetch;
  onDownloadStart?: (event: UvDownloadStartEvent) => void;
  onProgress?: (event: UvDownloadProgressEvent) => void;
  onRetry?: (event: UvDownloadRetryEvent) => void;
  platform?: NodeJS.Platform;
  progressIntervalMs?: number;
  requestTimeoutMs?: number;
  retryDelaysMs?: number[];
  stallTimeoutMs?: number;
  uvBin?: string;
}

interface UvDownloadStartEvent {
  downloadedBytes: number;
  size: number;
  url: string;
  version: string;
}

interface UvDownloadProgressEvent {
  downloadedBytes: number;
  size: number;
  url: string;
}

interface UvDownloadRetryEvent extends Omit<ResumableDownloadRetryEvent, 'totalBytes'> {
  downloadedBytes: number;
  size: number;
  url: string;
}

const defaultUvDownloadProgressIntervalMs = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeUvToolManifest(value: unknown): UvToolManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.name !== 'uv' ||
    typeof value.version !== 'string' ||
    typeof value.license !== 'string' ||
    !Array.isArray(value.licenseFiles) ||
    !isRecord(value.assets)
  ) {
    throw new Error('Invalid checked-in uv tool manifest');
  }
  const assets: Record<string, UvToolAsset> = {};
  for (const [key, asset] of Object.entries(value.assets)) {
    if (
      !isRecord(asset) ||
      typeof asset.file !== 'string' ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      typeof asset.size !== 'number' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      typeof asset.url !== 'string'
    ) {
      throw new Error(`Invalid uv tool asset: ${key}`);
    }
    assets[key] = {
      file: asset.file,
      sha256: asset.sha256,
      size: asset.size,
      url: new URL(asset.url).toString(),
    };
  }
  const licenseFiles = value.licenseFiles.map((licenseFile) => {
    if (
      !isRecord(licenseFile) ||
      typeof licenseFile.name !== 'string' ||
      !licenseFile.name ||
      typeof licenseFile.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(licenseFile.sha256) ||
      typeof licenseFile.url !== 'string'
    ) {
      throw new Error('Invalid uv tool license file');
    }
    return {
      name: licenseFile.name,
      sha256: licenseFile.sha256,
      url: new URL(licenseFile.url).toString(),
    };
  });
  return {
    assets,
    license: value.license,
    licenseFiles,
    name: 'uv',
    schemaVersion: 1,
    version: value.version,
  };
}

export const uvToolManifest = normalizeUvToolManifest(manifestData);

export function uvCollectorAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): string {
  const key = `${platform}-${arch}`;
  if (!uvToolManifest.assets[key]) {
    throw new Error(`uv is not available for collector platform ${key}`);
  }
  return key;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file) as AsyncIterable<Buffer>) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

async function extractZip(file: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        const output = path.resolve(destination, entry.fileName);
        if (!output.startsWith(`${path.resolve(destination)}${path.sep}`)) {
          zip.close();
          reject(new Error(`Unsafe uv zip entry: ${entry.fileName}`));
          return;
        }
        if (entry.fileName.endsWith('/')) {
          void fs.ensureDir(output).then(() => {
            zip.readEntry();
          }, reject);
          return;
        }
        void fs
          .ensureDir(path.dirname(output))
          .then(
            () =>
              new Promise<void>((entryResolve, entryReject) => {
                zip.openReadStream(entry, (streamError, stream) => {
                  if (streamError) {
                    entryReject(streamError);
                    return;
                  }
                  const outputStream = fs.createWriteStream(output);
                  stream.on('error', entryReject);
                  outputStream.on('error', entryReject);
                  outputStream.on('close', entryResolve);
                  stream.pipe(outputStream);
                });
              })
          )
          .then(() => {
            zip.readEntry();
          }, reject);
      });
      zip.readEntry();
    });
  });
}

async function findUvExecutable(root: string, platform: NodeJS.Platform): Promise<string> {
  const expected = platform === 'win32' ? 'uv.exe' : 'uv';
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.name === expected) {
        return candidate;
      }
    }
  }
  throw new Error(`uv archive did not contain ${expected}`);
}

async function seedPersistentPartialArchive(
  versionParent: string,
  key: string,
  asset: UvToolAsset,
  archive: string
): Promise<void> {
  let bestSize = await fileSize(archive);
  let bestArchive: string | undefined;
  for (const entry of await fs.readdir(versionParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${key}-download-`)) {
      continue;
    }
    const candidate = path.join(versionParent, entry.name, asset.file);
    const candidateSize = await fileSize(candidate);
    if (candidateSize > bestSize && candidateSize <= asset.size) {
      bestArchive = candidate;
      bestSize = candidateSize;
    }
  }
  if (bestArchive) {
    await fs.copyFile(bestArchive, archive);
  }
}

export async function acquireUv(options: AcquireUvOptions): Promise<string> {
  if (options.uvBin) {
    return path.resolve(options.uvBin);
  }
  const platform = options.platform ?? process.platform;
  const key = uvCollectorAssetKey(platform, options.arch ?? process.arch);
  const asset = uvToolManifest.assets[key]!;
  const versionRoot = path.resolve(options.cacheDir, 'uv', uvToolManifest.version, key);
  const executableMarker = path.join(versionRoot, platform === 'win32' ? 'uv.exe.path' : 'uv.path');
  if (await fs.pathExists(executableMarker)) {
    const executable = (await fs.readFile(executableMarker, 'utf8')).trim();
    if (executable && (await fs.pathExists(executable))) {
      return executable;
    }
  }

  const versionParent = path.dirname(versionRoot);
  const stagingRoot = `${versionRoot}.partial`;
  const archive = path.join(stagingRoot, asset.file);
  const extracted = path.join(stagingRoot, 'extracted');
  await fs.ensureDir(stagingRoot);
  await seedPersistentPartialArchive(versionParent, key, asset, archive);
  await downloadResumableHttpFile({
    expectedSize: asset.size,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onProgress: ({ downloadedBytes, url }) => {
      options.onProgress?.({ downloadedBytes, size: asset.size, url });
    },
    onRetry: (event) => {
      options.onRetry?.({
        attempt: event.attempt,
        delayMs: event.delayMs,
        downloadedBytes: event.downloadedBytes,
        error: event.error,
        nextAttempt: event.nextAttempt,
        size: asset.size,
        url: event.url,
      });
    },
    onStart: ({ downloadedBytes, url }) => {
      options.onDownloadStart?.({
        downloadedBytes,
        size: asset.size,
        url,
        version: uvToolManifest.version,
      });
    },
    progressIntervalMs: options.progressIntervalMs ?? defaultUvDownloadProgressIntervalMs,
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    ...(options.stallTimeoutMs ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
    targetPath: archive,
    url: asset.url,
    validateFile: async (filePath) => {
      const digest = await sha256File(filePath);
      if (digest !== asset.sha256) {
        throw new Error(`uv SHA-256 mismatch: expected ${asset.sha256}, received ${digest}`);
      }
    },
  });

  await fs.remove(extracted);
  await fs.ensureDir(extracted);
  if (asset.file.endsWith('.tar.gz')) {
    await tar.x({
      cwd: extracted,
      file: archive,
      preservePaths: false,
      strict: true,
    });
  } else if (asset.file.endsWith('.zip')) {
    await extractZip(archive, extracted);
  } else {
    throw new Error(`Unsupported uv archive format: ${asset.file}`);
  }
  const stagedExecutable = await findUvExecutable(extracted, platform);
  const executableRelativePath = path.relative(stagingRoot, stagedExecutable);
  await fs.remove(versionRoot);
  await fs.rename(stagingRoot, versionRoot);
  const executable = path.join(versionRoot, executableRelativePath);
  if (platform !== 'win32') {
    await fs.chmod(executable, 0o755);
  }
  await fs.writeFile(executableMarker, `${executable}\n`);
  return executable;
}
