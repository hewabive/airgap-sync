import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import * as yauzl from 'yauzl';
import manifestData from '../../../support/python/uv-tool-manifest.json' with { type: 'json' };
import * as fs from '../fs.js';
import { HttpStatusError, isRetryableFetchError, retry, type RetryEvent } from '../retry.js';

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

interface UvDownloadRetryEvent extends RetryEvent {
  downloadedBytes: number;
  size: number;
  url: string;
}

const defaultUvDownloadProgressIntervalMs = 15_000;
const defaultUvDownloadRequestTimeoutMs = 60_000;
const defaultUvDownloadStallTimeoutMs = 60_000;

class IncompleteUvDownloadError extends Error {
  constructor(downloadedBytes: number, expectedBytes: number) {
    super(
      `uv download ended early: received ${String(downloadedBytes)} of ${String(expectedBytes)} bytes`
    );
    this.name = 'IncompleteUvDownloadError';
  }
}

class UvDownloadRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`uv download server did not respond within ${String(timeoutMs)}ms`);
    this.name = 'UvDownloadRequestTimeoutError';
  }
}

class UvDownloadStallError extends Error {
  constructor(timeoutMs: number) {
    super(`uv download received no data for ${String(timeoutMs)}ms`);
    this.name = 'UvDownloadStallError';
  }
}

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

function describeError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const prefix = current.name && current.name !== 'Error' ? `${current.name}: ` : '';
    messages.push(`${prefix}${current.message}`);
    current = 'cause' in current ? current.cause : undefined;
  }
  if (messages.length === 0) {
    return String(error);
  }
  return messages.join('; caused by ');
}

function validateContentRange(response: Response, offset: number, expectedSize: number): void {
  const contentRange = response.headers.get('content-range');
  const parsed = contentRange ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(contentRange) : null;
  if (
    !parsed ||
    Number(parsed[1]) !== offset ||
    (parsed[3] !== '*' && Number(parsed[3]) !== expectedSize)
  ) {
    throw new Error(
      `uv download returned an invalid Content-Range for offset ${String(offset)}: ${contentRange ?? 'missing'}`
    );
  }
}

interface DownloadUvAssetOptions {
  archive: string;
  asset: UvToolAsset;
  fetch: typeof globalThis.fetch;
  onProgress?: (event: UvDownloadProgressEvent) => void;
  onRetry?: (event: UvDownloadRetryEvent) => void;
  progressIntervalMs: number;
  requestTimeoutMs: number;
  retryDelaysMs?: number[];
  stallTimeoutMs: number;
}

async function fetchUvAsset(
  options: DownloadUvAssetOptions,
  offset: number
): Promise<{ controller: AbortController; response: Response }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new UvDownloadRequestTimeoutError(options.requestTimeoutMs));
  }, options.requestTimeoutMs);
  try {
    const response = await options.fetch(options.asset.url, {
      ...(offset > 0 ? { headers: { Range: `bytes=${String(offset)}-` } } : {}),
      redirect: 'follow',
      signal: controller.signal,
    });
    return { controller, response };
  } catch (error) {
    if (controller.signal.reason instanceof UvDownloadRequestTimeoutError) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadUvAsset(options: DownloadUvAssetOptions): Promise<void> {
  let attempts = 0;
  let downloadedBytes = await fileSize(options.archive);
  try {
    await retry(
      async () => {
        attempts++;
        let offset = await fileSize(options.archive);
        if (offset > options.asset.size) {
          await fs.remove(options.archive);
          offset = 0;
        }
        if (offset === options.asset.size) {
          downloadedBytes = offset;
          return;
        }

        const { controller, response } = await fetchUvAsset(options, offset);
        if (response.status !== 200 && response.status !== 206) {
          throw new HttpStatusError(
            `uv download failed with HTTP ${String(response.status)}: ${options.asset.url}`,
            response.status
          );
        }
        if (!response.body) {
          throw new IncompleteUvDownloadError(offset, options.asset.size);
        }

        const append = offset > 0 && response.status === 206;
        if (response.status === 206) {
          try {
            validateContentRange(response, append ? offset : 0, options.asset.size);
          } catch (error) {
            await fs.remove(options.archive);
            downloadedBytes = 0;
            throw error;
          }
        }
        if (!append) {
          offset = 0;
        }

        downloadedBytes = offset;
        let stallTimer: NodeJS.Timeout | undefined;
        let lastProgressAt = Date.now();
        const armStallTimer = (): void => {
          if (stallTimer) {
            clearTimeout(stallTimer);
          }
          stallTimer = setTimeout(() => {
            controller.abort(new UvDownloadStallError(options.stallTimeoutMs));
          }, options.stallTimeoutMs);
        };
        const progress = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            downloadedBytes += chunk.length;
            armStallTimer();
            const now = Date.now();
            if (now - lastProgressAt >= options.progressIntervalMs) {
              lastProgressAt = now;
              options.onProgress?.({
                downloadedBytes,
                size: options.asset.size,
                url: options.asset.url,
              });
            }
            callback(null, chunk);
          },
        });
        armStallTimer();
        try {
          await pipeline(
            Readable.fromWeb(response.body),
            progress,
            fs.createWriteStream(options.archive, { flags: append ? 'a' : 'w' }),
            { signal: controller.signal }
          );
        } catch (error) {
          if (controller.signal.reason instanceof UvDownloadStallError) {
            throw controller.signal.reason;
          }
          throw error;
        } finally {
          if (stallTimer) {
            clearTimeout(stallTimer);
          }
          downloadedBytes = await fileSize(options.archive);
        }

        options.onProgress?.({
          downloadedBytes,
          size: options.asset.size,
          url: options.asset.url,
        });

        if (downloadedBytes < options.asset.size) {
          throw new IncompleteUvDownloadError(downloadedBytes, options.asset.size);
        }
        if (downloadedBytes > options.asset.size) {
          throw new Error(
            `uv size mismatch: expected ${String(options.asset.size)}, received ${String(downloadedBytes)}`
          );
        }
      },
      {
        ...(options.retryDelaysMs ? { delaysMs: options.retryDelaysMs } : {}),
        isRetryable: (error) =>
          error instanceof IncompleteUvDownloadError ||
          error instanceof UvDownloadRequestTimeoutError ||
          error instanceof UvDownloadStallError ||
          isRetryableFetchError(error),
        onRetry: (event) => {
          options.onRetry?.({
            ...event,
            downloadedBytes,
            size: options.asset.size,
            url: options.asset.url,
          });
        },
      }
    );
  } catch (error) {
    throw new Error(
      `uv download failed after ${String(attempts)} ${attempts === 1 ? 'attempt' : 'attempts'} from ${options.asset.url}: ${describeError(error)}`,
      { cause: error }
    );
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
  options.onDownloadStart?.({
    downloadedBytes: await fileSize(archive),
    size: asset.size,
    url: asset.url,
    version: uvToolManifest.version,
  });
  await downloadUvAsset({
    archive,
    asset,
    fetch: options.fetch ?? globalThis.fetch,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    progressIntervalMs: options.progressIntervalMs ?? defaultUvDownloadProgressIntervalMs,
    requestTimeoutMs: options.requestTimeoutMs ?? defaultUvDownloadRequestTimeoutMs,
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    stallTimeoutMs: options.stallTimeoutMs ?? defaultUvDownloadStallTimeoutMs,
  });
  const digest = await sha256File(archive);
  if (digest !== asset.sha256) {
    await fs.remove(archive);
    throw new Error(`uv SHA-256 mismatch: expected ${asset.sha256}, received ${digest}`);
  }

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
