import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as fs from '../fs.js';
import { downloadResumableHttpFile } from '../resumable-download.js';
import { HttpStatusError, isRetryableFetchError, retry } from '../retry.js';
import { compareVersions } from './pep440.js';
import { normalizePackageName } from './names.js';
import { normalizeHashes, selectStrongHash, verifyBufferHash } from './integrity.js';
import {
  type PythonArtifactIdentity,
  type PythonCoreMetadata,
  PythonMetadataCache,
  parseCoreMetadata,
} from './metadata.js';
import { parseWheelFilename } from './wheels.js';
import { readWheelMetadata } from './wheel-metadata.js';

const simpleJsonContentType = 'application/vnd.pypi.simple.v1+json';

export interface PythonIndexFile {
  coreMetadata?: true | Record<string, string>;
  filename: string;
  hashes: Record<string, string>;
  requiresPython?: string;
  size?: number;
  uploadTime?: string;
  url: string;
  yanked?: true | string;
}

export interface PythonProjectIndex {
  apiVersion: string;
  files: PythonIndexFile[];
  name: string;
}

export interface PythonMetadataResult {
  metadata: PythonCoreMetadata;
  source: 'cache' | 'core-metadata' | 'wheel';
}

export interface HttpPythonIndexClientOptions {
  retryDelaysMs?: number[];
  timeoutMs?: number;
}

export interface PythonIndexClient {
  readonly sourceIndex: string;
  getMetadata(file: PythonIndexFile, cache: PythonMetadataCache): Promise<PythonMetadataResult>;
  getProject(name: string): Promise<PythonProjectIndex>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeIndexUrl(indexUrl: string): string {
  const parsed = new URL(indexUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Python source index must use HTTP or HTTPS: ${indexUrl}`);
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/+$/, '');
}

function decodeUtf8(buffer: Uint8Array, description: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Error(`${description} is not valid UTF-8: ${(error as Error).message}`);
  }
}

function hashFromUrlFragment(url: URL): Record<string, string> {
  const separator = url.hash.indexOf('=');
  if (separator <= 1) {
    return {};
  }
  return normalizeHashes({
    [url.hash.slice(1, separator)]: url.hash.slice(separator + 1),
  });
}

function parseCoreMetadataHashes(value: unknown): true | Record<string, string> | undefined {
  if (value === true) {
    return true;
  }
  if (isRecord(value)) {
    const hashes = normalizeHashes(value);
    return Object.keys(hashes).length > 0 ? hashes : undefined;
  }
  return undefined;
}

function parseIndexFile(value: unknown, responseUrl: string): PythonIndexFile {
  if (!isRecord(value) || typeof value.filename !== 'string' || typeof value.url !== 'string') {
    throw new Error('Python index file entry is missing filename or url');
  }
  if (
    !value.filename ||
    value.filename.includes('/') ||
    value.filename.includes('\\') ||
    value.filename.includes('\0')
  ) {
    throw new Error(`Python index returned an unsafe filename: ${value.filename}`);
  }

  const fileUrl = new URL(value.url, responseUrl);
  if (fileUrl.protocol !== 'http:' && fileUrl.protocol !== 'https:') {
    throw new Error(`Python package file must use HTTP or HTTPS: ${fileUrl.toString()}`);
  }
  const hashes = {
    ...hashFromUrlFragment(fileUrl),
    ...normalizeHashes(value.hashes),
  };
  const coreMetadata = parseCoreMetadataHashes(
    value['core-metadata'] ?? value['dist-info-metadata']
  );
  const yanked =
    value.yanked === true || (typeof value.yanked === 'string' && value.yanked.length > 0)
      ? value.yanked
      : undefined;

  return {
    filename: value.filename,
    hashes,
    url: fileUrl.toString(),
    ...(coreMetadata ? { coreMetadata } : {}),
    ...(typeof value['requires-python'] === 'string'
      ? { requiresPython: value['requires-python'] }
      : {}),
    ...(typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
      ? { size: value.size }
      : {}),
    ...(typeof value['upload-time'] === 'string' ? { uploadTime: value['upload-time'] } : {}),
    ...(yanked !== undefined ? { yanked } : {}),
  };
}

function artifactIdentity(sourceIndex: string, file: PythonIndexFile): PythonArtifactIdentity {
  return {
    hashes: file.hashes,
    sourceIndex,
    url: file.url,
  };
}

function validateMetadataForFile(file: PythonIndexFile, metadata: PythonCoreMetadata): void {
  const wheel = parseWheelFilename(file.filename);
  if (!wheel) {
    throw new Error(`Only wheel metadata is supported in v1: ${file.filename}`);
  }
  if (normalizePackageName(metadata.name) !== wheel.normalizedName) {
    throw new Error(
      `Core metadata name ${metadata.name} does not match wheel filename ${file.filename}`
    );
  }
  if (compareVersions(metadata.version, wheel.version) !== 0) {
    throw new Error(
      `Core metadata version ${metadata.version} does not match wheel filename ${file.filename}`
    );
  }
}

export class HttpPythonIndexClient implements PythonIndexClient {
  readonly #retryDelaysMs: number[] | undefined;
  readonly #sourceIndex: string;
  readonly #timeoutMs: number;

  constructor(indexUrl: string, options: HttpPythonIndexClientOptions = {}) {
    this.#sourceIndex = normalizeIndexUrl(indexUrl);
    this.#retryDelaysMs = options.retryDelaysMs;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  get sourceIndex(): string {
    return this.#sourceIndex;
  }

  async #fetch(url: string, accept?: string): Promise<Response> {
    return retry(
      async () => {
        const response = await fetch(url, {
          ...(accept ? { headers: { Accept: accept } } : {}),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (response.status !== 200) {
          throw new HttpStatusError(
            `Python index request failed with status ${String(response.status)}: ${url}`,
            response.status
          );
        }
        return response;
      },
      {
        ...(this.#retryDelaysMs ? { delaysMs: this.#retryDelaysMs } : {}),
        isRetryable: isRetryableFetchError,
      }
    );
  }

  async getProject(name: string): Promise<PythonProjectIndex> {
    const normalizedName = normalizePackageName(name);
    const response = await this.#fetch(
      `${this.#sourceIndex}/${encodeURIComponent(normalizedName)}/`,
      simpleJsonContentType
    );
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
    if (contentType !== simpleJsonContentType) {
      throw new Error(
        `Python source index did not return the PEP 691 JSON content type for ${normalizedName}: ${contentType ?? 'missing'}`
      );
    }

    const data: unknown = await response.json();
    if (!isRecord(data) || !Array.isArray(data.files)) {
      throw new Error(`Python source index returned invalid project JSON for ${normalizedName}`);
    }
    const meta = isRecord(data.meta) ? data.meta : {};
    const apiVersion = typeof meta['api-version'] === 'string' ? meta['api-version'] : '1.0';
    const major = Number.parseInt(apiVersion.split('.', 1)[0] ?? '', 10);
    if (major !== 1) {
      throw new Error(`Unsupported Python Simple API version: ${apiVersion}`);
    }
    const projectName =
      typeof data.name === 'string' ? normalizePackageName(data.name) : normalizedName;
    if (projectName !== normalizedName) {
      throw new Error(
        `Python source index returned project ${String(data.name)} for request ${normalizedName}`
      );
    }

    return {
      apiVersion,
      files: data.files.map((file) => parseIndexFile(file, response.url)),
      name: normalizedName,
    };
  }

  async #metadataFromEndpoint(file: PythonIndexFile): Promise<PythonCoreMetadata | undefined> {
    if (file.coreMetadata === undefined || file.coreMetadata === true) {
      return undefined;
    }
    const expected = selectStrongHash(file.coreMetadata);
    if (!expected) {
      return undefined;
    }

    const metadataUrl = new URL(file.url);
    metadataUrl.hash = '';
    metadataUrl.pathname += '.metadata';
    const response = await this.#fetch(metadataUrl.toString());
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 16 * 1024 * 1024) {
      throw new Error(`Core metadata is too large: ${String(contentLength)} bytes`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > 16 * 1024 * 1024) {
      throw new Error(`Core metadata is too large: ${String(buffer.byteLength)} bytes`);
    }
    verifyBufferHash(buffer, expected);
    return parseCoreMetadata(decodeUtf8(buffer, 'Core metadata'));
  }

  async #downloadWheel(file: PythonIndexFile, targetPath: string): Promise<void> {
    const expected = selectStrongHash(file.hashes);
    if (!expected) {
      throw new Error(`Wheel has no supported sha256-or-stronger hash: ${file.filename}`);
    }

    await downloadResumableHttpFile({
      ...(file.size === undefined ? {} : { expectedSize: file.size }),
      ...(this.#retryDelaysMs ? { retryDelaysMs: this.#retryDelaysMs } : {}),
      stallTimeoutMs: this.#timeoutMs,
      targetPath,
      url: file.url,
      validateFile: async (filePath) => {
        const expectedHash = createHash(expected.algorithm);
        for await (const chunk of fs.createReadStream(filePath) as AsyncIterable<Buffer>) {
          expectedHash.update(chunk);
        }
        const actual = expectedHash.digest('hex');
        if (actual !== expected.digest) {
          throw new Error(
            `${expected.algorithm} mismatch for ${file.filename}: expected ${expected.digest}, received ${actual}`
          );
        }
      },
    });
  }

  async getMetadata(
    file: PythonIndexFile,
    cache: PythonMetadataCache
  ): Promise<PythonMetadataResult> {
    const identity = artifactIdentity(this.#sourceIndex, file);
    const cached = cache.get(identity);
    if (cached) {
      validateMetadataForFile(file, cached);
      return { metadata: cached, source: 'cache' };
    }

    const endpointMetadata = await this.#metadataFromEndpoint(file);
    if (endpointMetadata) {
      validateMetadataForFile(file, endpointMetadata);
      cache.set(identity, endpointMetadata);
      return { metadata: endpointMetadata, source: 'core-metadata' };
    }

    if (!file.filename.endsWith('.whl')) {
      throw new Error(`Core metadata is unavailable for non-wheel file: ${file.filename}`);
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-wheel-'));
    const tempPath = path.join(tempDir, file.filename);
    try {
      await this.#downloadWheel(file, tempPath);
      const metadata = parseCoreMetadata(await readWheelMetadata(tempPath));
      validateMetadataForFile(file, metadata);
      cache.set(identity, metadata);
      return { metadata, source: 'wheel' };
    } finally {
      await fs.remove(tempDir);
    }
  }
}
