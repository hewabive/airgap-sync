import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as fs from '../fs.js';
import type { PythonSeedFile, PythonSeedManifest } from './bundle.js';
import {
  createPythonFilePublishProgress,
  type PythonFilePublishProgress,
  type PythonPublishProgressEvent,
} from './publish-progress.js';
import { parseWheelFilename } from './wheels.js';

export interface PythonPublishAuth {
  password: string;
  username: string;
}

export interface PythonPublishAction {
  error?: string;
  file: string;
  package: string;
  status: 'planned' | 'published' | 'skipped' | 'error';
}

export interface PythonPublishReport {
  actions: PythonPublishAction[];
  dryRun: boolean;
  enabled: boolean;
  errors: PythonPublishAction[];
  generatedAt: string;
  indexUrl: string;
  owner: string;
  pipConfig: string;
  planned: number;
  published: number;
  skipped: number;
  uploadUrl: string;
}

export interface PublishPythonBundleOptions {
  auth?: PythonPublishAuth;
  bundleDir: string;
  concurrency?: number;
  dryRun?: boolean;
  generatedAt?: string;
  giteaBaseUrl: string;
  onProgress?: (event: PythonPublishProgressEvent) => void;
  owner: string;
  timeoutMs?: number;
}

interface MultipartPart {
  body: Buffer;
  header: Buffer;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Gitea URL must use HTTP or HTTPS: ${value}`);
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function validateOwner(owner: string): string {
  const trimmed = owner.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/\0]/.test(trimmed)) {
    throw new Error(`Invalid Python publish owner: ${owner}`);
  }
  return trimmed;
}

function quote(value: string): string {
  return value.replace(/["\r\n]/g, '_');
}

function fieldPart(boundary: string, name: string, value: string): MultipartPart {
  return {
    body: Buffer.from(value),
    header: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n`
    ),
  };
}

function uploadFields(file: PythonSeedFile): [string, string][] {
  const metadata = file.coreMetadata;
  const wheel = parseWheelFilename(file.filename);
  if (!wheel) {
    throw new Error(`Invalid wheel filename in Python seed manifest: ${file.filename}`);
  }
  return [
    [':action', 'file_upload'],
    ['protocol_version', '1'],
    ['metadata_version', metadata.metadataVersion],
    ['name', metadata.name],
    ['version', metadata.version],
    ['filetype', 'bdist_wheel'],
    ['pyversion', wheel.pythonTags.join('.')],
    ['sha256_digest', file.sha256],
    ...(metadata.summary ? [['summary', metadata.summary] as [string, string]] : []),
    ...(metadata.author ? [['author', metadata.author] as [string, string]] : []),
    ...(metadata.authorEmail ? [['author_email', metadata.authorEmail] as [string, string]] : []),
    ...(metadata.homePage ? [['home_page', metadata.homePage] as [string, string]] : []),
    ...(metadata.license ? [['license', metadata.license] as [string, string]] : []),
    ...(metadata.requiresPython
      ? [['requires_python', metadata.requiresPython] as [string, string]]
      : []),
    ...(metadata.description ? [['description', metadata.description] as [string, string]] : []),
    ...(metadata.descriptionContentType
      ? [['description_content_type', metadata.descriptionContentType] as [string, string]]
      : []),
    ...metadata.projectUrls.map((value): [string, string] => ['project_urls', value]),
    ...metadata.requiresDist.map((value): [string, string] => ['requires_dist', value]),
    ...metadata.providesExtra.map((value): [string, string] => ['provides_extra', value]),
  ];
}

async function multipartBody(
  filePath: string,
  file: PythonSeedFile,
  onProgress?: PythonFilePublishProgress
): Promise<{ body: Readable; boundary: string; length: number }> {
  const boundary = `airgap-sync-${randomBytes(18).toString('hex')}`;
  const parts = uploadFields(file).map(([name, value]) => fieldPart(boundary, name, value));
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${quote(file.filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const separator = Buffer.from('\r\n');
  const closing = Buffer.from(`--${boundary}--\r\n`);
  const fileSize = (await fs.stat(filePath)).size;
  const length =
    parts.reduce((total, part) => total + part.header.length + part.body.length + 2, 0) +
    fileHeader.length +
    fileSize +
    separator.length +
    closing.length;
  async function* chunks(): AsyncGenerator<Buffer> {
    for (const part of parts) {
      yield part.header;
      yield part.body;
      yield separator;
    }
    yield fileHeader;
    let uploadedBytes = 0;
    onProgress?.('upload', uploadedBytes, fileSize);
    for await (const chunk of fs.createReadStream(filePath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      uploadedBytes += buffer.byteLength;
      onProgress?.('upload', uploadedBytes, fileSize);
      yield buffer;
    }
    yield separator;
    yield closing;
  }
  return { body: Readable.from(chunks()), boundary, length };
}

function authHeader(auth: PythonPublishAuth | undefined): Record<string, string> {
  return auth
    ? {
        Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
      }
    : {};
}

function bufferChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array || typeof chunk === 'string') {
    return Buffer.from(chunk);
  }
  throw new Error('HTTP or file stream returned an unsupported chunk');
}

async function localFileHash(
  filePath: string,
  onProgress?: PythonFilePublishProgress
): Promise<string> {
  const hash = createHash('sha256');
  const totalBytes = (await fs.stat(filePath)).size;
  let bytes = 0;
  onProgress?.('verify', bytes, totalBytes);
  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = bufferChunk(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
    onProgress?.('verify', bytes, totalBytes);
  }
  return hash.digest('hex');
}

async function verifyExistingFile(options: {
  auth?: PythonPublishAuth;
  file: PythonSeedFile;
  indexUrl: string;
  onProgress?: PythonFilePublishProgress;
  timeoutMs: number;
}): Promise<boolean> {
  const metadata = options.file.coreMetadata;
  const url = `${options.indexUrl.replace(/\/simple$/, '')}/files/${encodeURIComponent(metadata.name.toLowerCase().replace(/[-_.]+/g, '-'))}/${encodeURIComponent(metadata.version)}/${encodeURIComponent(options.file.filename)}`;
  const response = await fetch(url, {
    headers: authHeader(options.auth),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok || !response.body) {
    throw new Error(`unable to verify existing Gitea file: HTTP ${String(response.status)}`);
  }
  const hash = createHash('sha256');
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  const totalBytes =
    contentLength !== undefined && Number.isFinite(contentLength) && contentLength >= 0
      ? contentLength
      : undefined;
  let bytes = 0;
  options.onProgress?.('verify existing', bytes, totalBytes);
  for await (const chunk of Readable.fromWeb(response.body)) {
    const buffer = bufferChunk(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
    options.onProgress?.('verify existing', bytes, totalBytes);
  }
  return hash.digest('hex') === options.file.sha256;
}

function errorMessage(status: number, body: string): string {
  const detail = body.trim().slice(0, 500);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 413) {
    return `Gitea rejected the wheel as too large (HTTP 413); raise Gitea package limits and reverse-proxy request size${suffix}`;
  }
  if (status === 403 && /quota|size/i.test(body)) {
    return `Gitea rejected the wheel because of a package quota or size limit (HTTP 403)${suffix}`;
  }
  if (status === 404) {
    return `Gitea PyPI upload failed with HTTP 404; verify Gitea [packages] ENABLED=true and that the token has package write permission${suffix}`;
  }
  return `Gitea PyPI upload failed with HTTP ${String(status)}${suffix}`;
}

async function publishFile(options: {
  auth?: PythonPublishAuth;
  bundleDir: string;
  file: PythonSeedFile;
  indexUrl: string;
  onProgress?: PythonFilePublishProgress;
  timeoutMs: number;
  uploadUrl: string;
}): Promise<'published' | 'skipped'> {
  const filePath = path.join(options.bundleDir, options.file.file);
  if ((await localFileHash(filePath, options.onProgress)) !== options.file.sha256) {
    throw new Error(`bundle sha256 mismatch for ${options.file.file}`);
  }
  const multipart = await multipartBody(filePath, options.file, options.onProgress);
  const response = await fetch(options.uploadUrl, {
    body: multipart.body,
    duplex: 'half',
    headers: {
      ...authHeader(options.auth),
      'Content-Length': String(multipart.length),
      'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
    },
    method: 'POST',
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (response.status === 201 || response.status === 200) {
    return 'published';
  }
  if (response.status === 409) {
    await response.text();
    if (await verifyExistingFile(options)) {
      return 'skipped';
    }
    throw new Error('Gitea reports a conflict, but the existing wheel sha256 differs');
  }
  throw new Error(errorMessage(response.status, await response.text()));
}

export async function publishPythonBundle(
  manifest: PythonSeedManifest,
  options: PublishPythonBundleOptions
): Promise<PythonPublishReport> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const dryRun = options.dryRun === true;
  const owner = validateOwner(options.owner);
  const baseUrl = normalizeBaseUrl(options.giteaBaseUrl);
  const uploadUrl = `${baseUrl}/api/packages/${encodeURIComponent(owner)}/pypi`;
  const indexUrl = `${uploadUrl}/simple`;
  const files = manifest.packages.flatMap((pkg) =>
    pkg.files.map((file) => ({ file, package: `${pkg.name}@${pkg.version}` }))
  );
  options.onProgress?.({ current: 0, status: 'start', total: files.length });
  const actions: PythonPublishAction[] = [];
  if (!dryRun && !options.auth) {
    actions.push(
      ...files.map((entry) => ({
        error: 'Python publishing requires a Gitea username and token',
        file: entry.file.file,
        package: entry.package,
        status: 'error' as const,
      }))
    );
  }
  let cursor = 0;
  let completed = 0;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  if (actions.length === 0) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, files.length) }, async () => {
        for (;;) {
          const index = cursor++;
          const entry = files[index];
          if (!entry) return;
          if (dryRun) {
            actions[index] = {
              file: entry.file.file,
              package: entry.package,
              status: 'planned',
            };
            completed += 1;
            options.onProgress?.({
              current: completed,
              detail: `planned ${entry.file.filename}`,
              status: 'progress',
              total: files.length,
            });
            continue;
          }
          const onFileProgress = options.onProgress
            ? createPythonFilePublishProgress({
                current: () => completed,
                filename: entry.file.filename,
                onProgress: options.onProgress,
                total: files.length,
              })
            : undefined;
          try {
            actions[index] = {
              file: entry.file.file,
              package: entry.package,
              status: await publishFile({
                ...(options.auth ? { auth: options.auth } : {}),
                bundleDir: options.bundleDir,
                file: entry.file,
                indexUrl,
                ...(onFileProgress ? { onProgress: onFileProgress } : {}),
                timeoutMs: options.timeoutMs ?? 300_000,
                uploadUrl,
              }),
            };
          } catch (error) {
            actions[index] = {
              error: (error as Error).message,
              file: entry.file.file,
              package: entry.package,
              status: 'error',
            };
          }
          completed += 1;
          const action = actions[index];
          options.onProgress?.({
            current: completed,
            detail: `${action.status} ${entry.file.filename}${
              action.error ? `: ${action.error}` : ''
            }`,
            status: 'progress',
            total: files.length,
          });
        }
      })
    );
  } else {
    completed = actions.length;
  }
  const errors = actions.filter((action) => action.status === 'error');
  const report: PythonPublishReport = {
    actions,
    dryRun,
    enabled: true,
    errors,
    generatedAt,
    indexUrl,
    owner,
    pipConfig: `[global]\nindex-url = ${indexUrl}\n`,
    planned: actions.filter((action) => action.status === 'planned').length,
    published: actions.filter((action) => action.status === 'published').length,
    skipped: actions.filter((action) => action.status === 'skipped').length,
    uploadUrl,
  };
  options.onProgress?.({
    current: completed,
    ...(errors.length === 0 ? {} : { detail: `${String(errors.length)} errors` }),
    status: errors.length === 0 ? 'done' : 'error',
    total: files.length,
  });
  return report;
}
