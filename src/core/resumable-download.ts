import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as fs from './fs.js';
import { HttpStatusError, isRetryableFetchError, retry, type RetryEvent } from './retry.js';

export interface ResumableDownloadProgressEvent {
  downloadedBytes: number;
  totalBytes?: number;
  url: string;
}

export interface ResumableDownloadRetryEvent extends RetryEvent {
  downloadedBytes: number;
  totalBytes?: number;
  url: string;
}

export interface ResumableDownloadOptions {
  expectedSize?: number;
  fetch?: typeof globalThis.fetch;
  onProgress?: (event: ResumableDownloadProgressEvent) => void;
  onRetry?: (event: ResumableDownloadRetryEvent) => void;
  onStart?: (event: ResumableDownloadProgressEvent) => void;
  partialPath?: string;
  progressIntervalMs?: number;
  requestTimeoutMs?: number;
  retryDelaysMs?: number[];
  stallTimeoutMs?: number;
  targetPath: string;
  url: string | URL;
  validateFile?: (filePath: string) => Promise<void>;
}

export interface ResumableDownloadResult {
  attempts: number;
  resumedFromBytes: number;
  size: number;
  status: 'downloaded' | 'existing';
}

const defaultProgressIntervalMs = 1_000;
const defaultRequestTimeoutMs = 60_000;
const defaultStallTimeoutMs = 60_000;

class IncompleteDownloadError extends Error {
  constructor(downloadedBytes: number, expectedBytes: number) {
    super(
      `download ended early: received ${String(downloadedBytes)} of ${String(expectedBytes)} bytes`
    );
    this.name = 'IncompleteDownloadError';
  }
}

class DownloadRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`server did not respond within ${String(timeoutMs)}ms`);
    this.name = 'DownloadRequestTimeoutError';
  }
}

class DownloadStallError extends Error {
  constructor(timeoutMs: number) {
    super(`received no data for ${String(timeoutMs)}ms`);
    this.name = 'DownloadStallError';
  }
}

async function fileSize(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
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
  return messages.length > 0 ? messages.join('; caused by ') : String(error);
}

interface ParsedContentRange {
  start: number;
  total?: number;
}

function parseContentRange(response: Response, offset: number): ParsedContentRange {
  const contentRange = response.headers.get('content-range');
  const parsed = contentRange ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(contentRange) : null;
  if (!parsed || Number(parsed[1]) !== offset) {
    throw new Error(
      `server returned an invalid Content-Range for offset ${String(offset)}: ${contentRange ?? 'missing'}`
    );
  }
  const end = Number(parsed[2]);
  if (!Number.isSafeInteger(end) || end < offset) {
    throw new Error(`server returned an invalid Content-Range: ${contentRange ?? 'missing'}`);
  }
  return {
    start: offset,
    ...(parsed[3] === '*' ? {} : { total: Number(parsed[3]) }),
  };
}

function unsatisfiedContentRangeSize(response: Response): number | undefined {
  const contentRange = response.headers.get('content-range');
  const parsed = contentRange ? /^bytes \*\/(\d+)$/u.exec(contentRange) : null;
  return parsed ? Number(parsed[1]) : undefined;
}

function responseContentLength(response: Response): number | undefined {
  const header = response.headers.get('content-length');
  if (header === null) {
    return undefined;
  }
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function fetchResponse(
  fetchImplementation: typeof globalThis.fetch,
  url: URL,
  offset: number,
  requestTimeoutMs: number
): Promise<{ controller: AbortController; response: Response }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DownloadRequestTimeoutError(requestTimeoutMs));
  }, requestTimeoutMs);
  try {
    const response = await fetchImplementation(url, {
      ...(offset > 0 ? { headers: { Range: `bytes=${String(offset)}-` } } : {}),
      redirect: 'follow',
      signal: controller.signal,
    });
    return { controller, response };
  } catch (error) {
    if (controller.signal.reason instanceof DownloadRequestTimeoutError) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function preparePartial(
  targetPath: string,
  partialPath: string,
  expectedSize: number | undefined,
  validateFile: ResumableDownloadOptions['validateFile']
): Promise<{ existing?: number; partial: number }> {
  const targetSize = await fileSize(targetPath);
  if (targetSize !== undefined) {
    const sizeMatches = expectedSize === undefined || targetSize === expectedSize;
    if (sizeMatches) {
      try {
        await validateFile?.(targetPath);
        return { existing: targetSize, partial: 0 };
      } catch {
        // A corrupt complete-looking target is replaced through the partial path below.
      }
    }
    const partialSize = (await fileSize(partialPath)) ?? 0;
    if ((expectedSize === undefined || targetSize < expectedSize) && targetSize > partialSize) {
      await fs.copyFile(targetPath, partialPath);
    }
    await fs.remove(targetPath);
  }
  let partialSize = (await fileSize(partialPath)) ?? 0;
  if (expectedSize !== undefined && partialSize > expectedSize) {
    await fs.remove(partialPath);
    partialSize = 0;
  }
  return { partial: partialSize };
}

export async function downloadResumableHttpFile(
  options: ResumableDownloadOptions
): Promise<ResumableDownloadResult> {
  const url = options.url instanceof URL ? options.url : new URL(options.url);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error(`Download URL must be credential-free HTTP or HTTPS: ${url.toString()}`);
  }
  if (
    options.expectedSize !== undefined &&
    (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 0)
  ) {
    throw new Error(`Invalid expected download size: ${String(options.expectedSize)}`);
  }

  const partialPath = options.partialPath ?? `${options.targetPath}.download.partial`;
  await fs.ensureDir(path.dirname(options.targetPath));
  const prepared = await preparePartial(
    options.targetPath,
    partialPath,
    options.expectedSize,
    options.validateFile
  );
  if (prepared.existing !== undefined) {
    return {
      attempts: 0,
      resumedFromBytes: 0,
      size: prepared.existing,
      status: 'existing',
    };
  }

  let downloadedBytes = prepared.partial;
  let expectedSize = options.expectedSize;
  const resumedFromBytes = downloadedBytes;
  let attempts = 0;
  const progressIntervalMs = options.progressIntervalMs ?? defaultProgressIntervalMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  const stallTimeoutMs = options.stallTimeoutMs ?? defaultStallTimeoutMs;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  options.onStart?.({
    downloadedBytes,
    ...(expectedSize === undefined ? {} : { totalBytes: expectedSize }),
    url: url.toString(),
  });

  try {
    await retry(
      async () => {
        attempts++;
        let offset = (await fileSize(partialPath)) ?? 0;
        if (expectedSize !== undefined && offset > expectedSize) {
          await fs.remove(partialPath);
          offset = 0;
        }
        if (expectedSize !== undefined && offset === expectedSize) {
          downloadedBytes = offset;
          return;
        }

        const { controller, response } = await fetchResponse(
          fetchImplementation,
          url,
          offset,
          requestTimeoutMs
        );
        if (response.status === 416 && offset > 0) {
          const total = unsatisfiedContentRangeSize(response);
          if (total === offset) {
            expectedSize = total;
            downloadedBytes = offset;
            return;
          }
        }
        if (response.status !== 200 && response.status !== 206) {
          throw new HttpStatusError(
            `Download failed with HTTP ${String(response.status)}: ${url.toString()}`,
            response.status
          );
        }
        if (!response.body) {
          throw new Error(`Download returned an empty response body: ${url.toString()}`);
        }

        const append = offset > 0 && response.status === 206;
        if (response.status === 206) {
          let range: ParsedContentRange;
          try {
            range = parseContentRange(response, append ? offset : 0);
          } catch (error) {
            await fs.remove(partialPath);
            downloadedBytes = 0;
            throw error;
          }
          if (range.total !== undefined) {
            if (expectedSize !== undefined && range.total !== expectedSize) {
              await fs.remove(partialPath);
              downloadedBytes = 0;
              throw new Error(
                `Download size changed: expected ${String(expectedSize)}, server reported ${String(range.total)}`
              );
            }
            expectedSize = range.total;
          }
        }
        if (!append) {
          offset = 0;
          const contentLength = responseContentLength(response);
          if (expectedSize === undefined && contentLength !== undefined) {
            expectedSize = contentLength;
          }
        }

        downloadedBytes = offset;
        let stallTimer: NodeJS.Timeout | undefined;
        let lastProgressAt = Date.now();
        const armStallTimer = (): void => {
          if (stallTimer) {
            clearTimeout(stallTimer);
          }
          stallTimer = setTimeout(() => {
            controller.abort(new DownloadStallError(stallTimeoutMs));
          }, stallTimeoutMs);
        };
        const progress = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            downloadedBytes += chunk.byteLength;
            armStallTimer();
            const now = Date.now();
            if (now - lastProgressAt >= progressIntervalMs) {
              lastProgressAt = now;
              options.onProgress?.({
                downloadedBytes,
                ...(expectedSize === undefined ? {} : { totalBytes: expectedSize }),
                url: url.toString(),
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
            fs.createWriteStream(partialPath, { flags: append ? 'a' : 'w' }),
            { signal: controller.signal }
          );
        } catch (error) {
          if (controller.signal.reason instanceof DownloadStallError) {
            throw controller.signal.reason;
          }
          throw error;
        } finally {
          if (stallTimer) {
            clearTimeout(stallTimer);
          }
          downloadedBytes = (await fileSize(partialPath)) ?? 0;
        }
        options.onProgress?.({
          downloadedBytes,
          ...(expectedSize === undefined ? {} : { totalBytes: expectedSize }),
          url: url.toString(),
        });
        if (expectedSize !== undefined && downloadedBytes < expectedSize) {
          throw new IncompleteDownloadError(downloadedBytes, expectedSize);
        }
        if (expectedSize !== undefined && downloadedBytes > expectedSize) {
          throw new Error(
            `Download size mismatch: expected ${String(expectedSize)}, received ${String(downloadedBytes)}`
          );
        }
      },
      {
        ...(options.retryDelaysMs ? { delaysMs: options.retryDelaysMs } : {}),
        isRetryable: (error) =>
          error instanceof DownloadRequestTimeoutError ||
          error instanceof DownloadStallError ||
          error instanceof IncompleteDownloadError ||
          isRetryableFetchError(error),
        onRetry: (event) => {
          options.onRetry?.({
            ...event,
            downloadedBytes,
            ...(expectedSize === undefined ? {} : { totalBytes: expectedSize }),
            url: url.toString(),
          });
        },
      }
    );
  } catch (error) {
    throw new Error(
      `Download failed after ${String(attempts)} ${attempts === 1 ? 'attempt' : 'attempts'} from ${url.toString()}: ${describeError(error)}`,
      { cause: error }
    );
  }

  try {
    await options.validateFile?.(partialPath);
  } catch (error) {
    await fs.remove(partialPath);
    throw error;
  }
  downloadedBytes = (await fileSize(partialPath)) ?? 0;
  await fs.remove(options.targetPath);
  await fs.rename(partialPath, options.targetPath);
  return {
    attempts,
    resumedFromBytes,
    size: downloadedBytes,
    status: 'downloaded',
  };
}
