import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { mapConcurrent, serializeByKey } from '../concurrency.js';
import * as fs from '../fs.js';
import {
  pythonApplicationManifestCoverageErrors,
  readPythonApplicationBundleIndex,
  type PythonApplicationBundleIndex,
} from './application-bundle.js';
import type { PythonPublicationManifest } from './publication-manifest.js';
import {
  createPythonFilePublishProgress,
  type PythonFilePublishProgress,
  type PythonPublishProgressEvent,
} from './publish-progress.js';
import { readPythonSeedManifest } from './bundle.js';
import { assertPythonSecurityGate } from './security.js';

const genericRegistryLookupConcurrency = 8;
const genericRegistryLookupTimeoutMs = 30_000;
const sha256Pattern = /^[a-f0-9]{64}$/iu;

export interface PythonGenericPublishAuth {
  password: string;
  username: string;
}

export interface PythonGenericPublishAction {
  error?: string;
  file: string;
  owner: string;
  package: string;
  status: 'error' | 'planned' | 'published' | 'skipped';
  version: string;
}

export interface PythonGenericPublishReport {
  actions: PythonGenericPublishAction[];
  dryRun: boolean;
  enabled: boolean;
  errors: PythonGenericPublishAction[];
  generatedAt: string;
  planned: number;
  publicationId?: string;
  published: number;
  skipped: number;
}

export interface PublishPythonGenericArtifactsOptions {
  auth?: PythonGenericPublishAuth;
  bundleDir: string;
  concurrency?: number;
  dryRun?: boolean;
  fetch?: typeof globalThis.fetch;
  generatedAt?: string;
  giteaBaseUrl: string;
  onProgress?: (event: PythonPublishProgressEvent) => void;
  publicationManifest: PythonPublicationManifest;
  timeoutMs?: number;
}

export interface GiteaGenericPackageFile {
  expectedSha256: string;
  expectedSize?: number;
  file: string;
  filename: string;
  owner: string;
  package: string;
  version: string;
}

interface GiteaGenericPackageRemoteFile {
  sha256?: string;
  size?: number;
}

export type GiteaGenericPackageVersionSnapshot = ReadonlyMap<string, GiteaGenericPackageRemoteFile>;

type GiteaGenericPackageFileStatus = 'matching' | 'mismatch' | 'missing' | 'unverified';

interface IndexedGenericFile {
  file: GiteaGenericPackageFile;
  index: number;
}

export function normalizeGiteaGenericBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Gitea URL must use HTTP or HTTPS: ${value}`);
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/u, '');
}

export function validateGiteaGenericCoordinate(value: string, description: string): string {
  if (!value || !/^[A-Za-z0-9._+-]+$/u.test(value)) {
    throw new Error(`Invalid Gitea Generic Package ${description}: ${value}`);
  }
  return value;
}

function safeFile(bundleDir: string, relativeFile: string): string {
  if (
    path.posix.isAbsolute(relativeFile) ||
    relativeFile.includes('\\') ||
    relativeFile.split('/').includes('..')
  ) {
    throw new Error(`Unsafe Python generic artifact path: ${relativeFile}`);
  }
  const absolute = path.resolve(bundleDir, relativeFile);
  const relative = path.relative(bundleDir, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Python generic artifact escapes the bundle: ${relativeFile}`);
  }
  return absolute;
}

async function sha256(filePath: string, onProgress?: PythonFilePublishProgress): Promise<string> {
  const hash = createHash('sha256');
  const totalBytes = (await fs.stat(filePath)).size;
  let bytes = 0;
  onProgress?.('verify', bytes, totalBytes);
  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    hash.update(buffer);
    bytes += buffer.byteLength;
    onProgress?.('verify', bytes, totalBytes);
  }
  return hash.digest('hex');
}

function authHeaders(auth: PythonGenericPublishAuth | undefined): Record<string, string> {
  return auth
    ? {
        Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
      }
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function giteaGenericPackageVersionKey(
  file: Pick<GiteaGenericPackageFile, 'owner' | 'package' | 'version'>
): string {
  return `${file.owner.toLowerCase()}\0${file.package.toLowerCase()}\0${file.version}`;
}

function genericVersionFilesUrl(
  baseUrl: string,
  file: Pick<GiteaGenericPackageFile, 'owner' | 'package' | 'version'>
): string {
  return `${baseUrl}/api/v1/packages/${encodeURIComponent(file.owner)}/generic/${encodeURIComponent(file.package)}/${encodeURIComponent(file.version)}/files`;
}

function parseGenericPackageVersionSnapshot(
  value: unknown
): GiteaGenericPackageVersionSnapshot | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const snapshot = new Map<string, GiteaGenericPackageRemoteFile>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name) {
      return undefined;
    }
    if (snapshot.has(item.name)) {
      return undefined;
    }
    const rawSha256 = typeof item.sha256 === 'string' ? item.sha256 : undefined;
    const sha256 = rawSha256 && sha256Pattern.test(rawSha256) ? rawSha256.toLowerCase() : undefined;
    const size =
      typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0
        ? item.size
        : undefined;
    snapshot.set(item.name, {
      ...(sha256 ? { sha256 } : {}),
      ...(size === undefined ? {} : { size }),
    });
  }
  return snapshot;
}

async function fetchGiteaGenericPackageVersionSnapshot(options: {
  auth?: PythonGenericPublishAuth;
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  file: Pick<GiteaGenericPackageFile, 'owner' | 'package' | 'version'>;
  timeoutMs: number;
}): Promise<GiteaGenericPackageVersionSnapshot | undefined> {
  try {
    const response = await options.fetch(genericVersionFilesUrl(options.baseUrl, options.file), {
      headers: {
        ...authHeaders(options.auth),
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(Math.min(options.timeoutMs, genericRegistryLookupTimeoutMs)),
    });
    if (response.status === 404) {
      await response.text();
      return new Map();
    }
    if (!response.ok) {
      await response.text();
      return undefined;
    }
    return parseGenericPackageVersionSnapshot(await response.json());
  } catch {
    return undefined;
  }
}

export async function lookupGiteaGenericPackageVersionSnapshots(options: {
  auth?: PythonGenericPublishAuth;
  baseUrl: string;
  concurrency?: number;
  fetch: typeof globalThis.fetch;
  files: readonly GiteaGenericPackageFile[];
  timeoutMs: number;
}): Promise<Map<string, GiteaGenericPackageVersionSnapshot | undefined>> {
  const coordinates = new Map<string, GiteaGenericPackageFile>();
  for (const file of options.files) {
    const key = giteaGenericPackageVersionKey(file);
    if (!coordinates.has(key)) {
      coordinates.set(key, file);
    }
  }
  const entries = await mapConcurrent(
    [...coordinates],
    options.concurrency ?? genericRegistryLookupConcurrency,
    async ([key, file]) =>
      [
        key,
        await fetchGiteaGenericPackageVersionSnapshot({
          ...(options.auth ? { auth: options.auth } : {}),
          baseUrl: options.baseUrl,
          fetch: options.fetch,
          file,
          timeoutMs: options.timeoutMs,
        }),
      ] as const
  );
  return new Map(entries);
}

function genericPackageFileStatus(
  snapshot: GiteaGenericPackageVersionSnapshot | undefined,
  file: GiteaGenericPackageFile
): GiteaGenericPackageFileStatus {
  if (!snapshot) {
    return 'unverified';
  }
  const remote = snapshot.get(file.filename);
  if (!remote) {
    return 'missing';
  }
  if (!remote.sha256) {
    return 'unverified';
  }
  if (
    remote.sha256 !== file.expectedSha256.toLowerCase() ||
    (file.expectedSize !== undefined &&
      remote.size !== undefined &&
      remote.size !== file.expectedSize)
  ) {
    return 'mismatch';
  }
  return 'matching';
}

function genericPackageMismatchError(file: GiteaGenericPackageFile): Error {
  return new Error(
    `Gitea already has ${file.filename} at ${file.package}/${file.version}, but the existing generic artifact differs from the bundle`
  );
}

function genericUrl(baseUrl: string, file: GiteaGenericPackageFile): string {
  return `${baseUrl}/api/packages/${encodeURIComponent(file.owner)}/generic/${encodeURIComponent(file.package)}/${encodeURIComponent(file.version)}/${encodeURIComponent(file.filename)}`;
}

async function remoteMatches(options: {
  auth?: PythonGenericPublishAuth;
  expectedSha256: string;
  fetch: typeof globalThis.fetch;
  onProgress?: PythonFilePublishProgress;
  timeoutMs: number;
  url: string;
}): Promise<boolean> {
  const response = await options.fetch(options.url, {
    headers: authHeaders(options.auth),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok || !response.body) {
    throw new Error(`unable to verify existing generic artifact: HTTP ${String(response.status)}`);
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
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    hash.update(buffer);
    bytes += buffer.byteLength;
    options.onProgress?.('verify existing', bytes, totalBytes);
  }
  return hash.digest('hex') === options.expectedSha256;
}

export async function publishGiteaGenericPackageFile(options: {
  auth?: PythonGenericPublishAuth;
  baseUrl: string;
  bundleDir: string;
  fetch: typeof globalThis.fetch;
  file: GiteaGenericPackageFile;
  onProgress?: PythonFilePublishProgress;
  remoteSnapshot?: GiteaGenericPackageVersionSnapshot;
  timeoutMs: number;
}): Promise<'published' | 'skipped'> {
  const remoteStatus = genericPackageFileStatus(options.remoteSnapshot, options.file);
  if (remoteStatus === 'matching') {
    return 'skipped';
  }
  if (remoteStatus === 'mismatch') {
    throw genericPackageMismatchError(options.file);
  }
  const filePath = safeFile(options.bundleDir, options.file.file);
  const digest = await sha256(filePath, options.onProgress);
  if (options.file.expectedSha256 && digest !== options.file.expectedSha256) {
    throw new Error(`bundle sha256 mismatch for ${options.file.file}`);
  }
  const url = genericUrl(options.baseUrl, options.file);
  const fileSize = (await fs.stat(filePath)).size;
  let uploadedBytes = 0;
  async function* uploadBody(): AsyncGenerator<Buffer> {
    options.onProgress?.('upload', uploadedBytes, fileSize);
    for await (const chunk of fs.createReadStream(filePath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      uploadedBytes += buffer.byteLength;
      options.onProgress?.('upload', uploadedBytes, fileSize);
      yield buffer;
    }
  }
  const response = await options.fetch(url, {
    body: Readable.from(uploadBody()),
    duplex: 'half',
    headers: {
      ...authHeaders(options.auth),
      'Content-Length': String(fileSize),
      'Content-Type': 'application/octet-stream',
    },
    method: 'PUT',
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (response.status === 200 || response.status === 201) {
    await response.text();
    return 'published';
  }
  if (response.status === 409) {
    await response.text();
    const refreshedSnapshot = await fetchGiteaGenericPackageVersionSnapshot({
      ...(options.auth ? { auth: options.auth } : {}),
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      file: options.file,
      timeoutMs: options.timeoutMs,
    });
    const refreshedStatus = genericPackageFileStatus(refreshedSnapshot, options.file);
    if (refreshedStatus === 'matching') {
      return 'skipped';
    }
    if (refreshedStatus === 'mismatch') {
      throw genericPackageMismatchError(options.file);
    }
    if (
      await remoteMatches({
        ...(options.auth ? { auth: options.auth } : {}),
        expectedSha256: digest,
        fetch: options.fetch,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        timeoutMs: options.timeoutMs,
        url,
      })
    ) {
      return 'skipped';
    }
    throw new Error('Gitea reports a conflict, but the existing generic artifact differs');
  }
  const detail = (await response.text()).trim().slice(0, 500);
  if (response.status === 404) {
    throw new Error(
      `Gitea Generic Package upload failed with HTTP 404; verify Gitea [packages] ENABLED=true and that the token has package write permission${detail ? `: ${detail}` : ''}`
    );
  }
  throw new Error(
    `Gitea Generic Package upload failed with HTTP ${String(response.status)}${detail ? `: ${detail}` : ''}`
  );
}

function applicationFiles(
  index: PythonApplicationBundleIndex,
  manifest: PythonPublicationManifest
): GiteaGenericPackageFile[] {
  const files: GiteaGenericPackageFile[] = [];
  for (const application of index.applications) {
    const publication = manifest.applications.find(
      (candidate) => candidate.targetId === application.targetId
    );
    if (publication?.planId !== application.planId) {
      throw new Error(
        `Python publication manifest does not match application ${application.targetId}`
      );
    }
    const expectedSourcePaths = [
      ...new Set([
        application.planPath,
        application.planDiffPath,
        application.prerequisiteReportPath,
        ...application.locks.map((lock) => lock.file),
      ]),
    ].sort();
    const sourcePaths = publication.sourceDocuments.map((document) => document.file).sort();
    if (
      expectedSourcePaths.length !== sourcePaths.length ||
      expectedSourcePaths.some((file, index) => file !== sourcePaths[index])
    ) {
      throw new Error(
        `Python publication manifest source documents do not match application ${application.targetId}`
      );
    }
    for (const document of [...publication.sourceDocuments, ...publication.documents]) {
      files.push({
        expectedSha256: document.digest,
        file: document.file,
        filename: validateGiteaGenericCoordinate(path.posix.basename(document.file), 'filename'),
        owner: validateGiteaGenericCoordinate(publication.genericPackage.owner, 'owner'),
        package: validateGiteaGenericCoordinate(publication.genericPackage.package, 'package name'),
        version: validateGiteaGenericCoordinate(publication.genericPackage.version, 'version'),
      });
    }
  }
  return files;
}

function groupFilesByPackage(files: GiteaGenericPackageFile[]): IndexedGenericFile[][] {
  const groups = new Map<string, IndexedGenericFile[]>();
  for (const [index, file] of files.entries()) {
    // Gitea creates the package row lazily, so concurrent first uploads for one
    // case-insensitive package name can race on its database unique constraint.
    const key = `${file.owner.toLowerCase()}\0${file.package.toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push({ file, index });
    groups.set(key, group);
  }
  return [...groups.values()];
}

export async function publishPythonGenericArtifacts(
  options: PublishPythonGenericArtifactsOptions
): Promise<PythonGenericPublishReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const dryRun = options.dryRun === true;
  options.onProgress?.({ current: 0, status: 'start' });
  const index = await readPythonApplicationBundleIndex(bundleDir);
  if (!index) {
    const report: PythonGenericPublishReport = {
      actions: [],
      dryRun,
      enabled: false,
      errors: [],
      generatedAt,
      planned: 0,
      publicationId: options.publicationManifest.publicationId,
      published: 0,
      skipped: 0,
    };
    options.onProgress?.({ current: 0, status: 'done', total: 0 });
    return report;
  }
  let pythonManifest;
  try {
    pythonManifest = await readPythonSeedManifest(bundleDir);
  } catch (error) {
    throw new Error(
      `Refusing Python publication: python-seed-manifest.json is missing or unreadable: ${(error as Error).message}`
    );
  }
  const coverageErrors = pythonApplicationManifestCoverageErrors(index, pythonManifest);
  if (coverageErrors.length > 0) {
    throw new Error(
      `Refusing Python publication: ${coverageErrors[0] ?? 'application wheels are not covered by the security manifest'}`
    );
  }
  await assertPythonSecurityGate(bundleDir, pythonManifest, {
    now: new Date(generatedAt),
  });
  let files: GiteaGenericPackageFile[];
  try {
    files = applicationFiles(index, options.publicationManifest).sort(
      (left, right) =>
        left.owner.localeCompare(right.owner) ||
        left.package.localeCompare(right.package) ||
        left.version.localeCompare(right.version) ||
        left.filename.localeCompare(right.filename)
    );
  } catch (error) {
    const action: PythonGenericPublishAction = {
      error: (error as Error).message,
      file: 'python/application-index.json',
      owner: '(plan)',
      package: '(application)',
      status: 'error',
      version: '(plan)',
    };
    const report: PythonGenericPublishReport = {
      actions: [action],
      dryRun,
      enabled: true,
      errors: [action],
      generatedAt,
      planned: 0,
      publicationId: options.publicationManifest.publicationId,
      published: 0,
      skipped: 0,
    };
    await fs.writeJson(
      path.join(
        bundleDir,
        dryRun
          ? 'python-application-publish-dry-run-report.json'
          : 'python-application-publish-report.json'
      ),
      report,
      { spaces: 2 }
    );
    options.onProgress?.({
      current: 0,
      detail: action.error ?? 'could not prepare Python application artifacts',
      status: 'error',
      total: 0,
    });
    return report;
  }
  options.onProgress?.({
    current: 0,
    detail: `${String(files.length)} artifacts`,
    status: 'progress',
    total: files.length,
  });
  const actions: PythonGenericPublishAction[] = [];
  if (!dryRun && !options.auth) {
    actions.push(
      ...files.map((file) => ({
        error: 'Python generic publishing requires a Gitea username and token',
        file: file.file,
        owner: file.owner,
        package: file.package,
        status: 'error' as const,
        version: file.version,
      }))
    );
  }
  const fileGroups = groupFilesByPackage(files);
  const baseUrl = normalizeGiteaGenericBaseUrl(options.giteaBaseUrl);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const remoteSnapshots =
    dryRun || !options.auth
      ? new Map<string, GiteaGenericPackageVersionSnapshot | undefined>()
      : await lookupGiteaGenericPackageVersionSnapshots({
          auth: options.auth,
          baseUrl,
          fetch: options.fetch ?? globalThis.fetch,
          files,
          timeoutMs,
        });
  // Gitea deduplicates package blobs globally by their hashes. Concurrent uploads of
  // identical content to different packages can both try to create the blob row and
  // make PostgreSQL reject one with UQE_package_blob_md5. Keep unrelated uploads
  // parallel, but let each content digest reach Gitea one request at a time.
  const digestUploadTails = new Map<string, Promise<void>>();
  let groupCursor = 0;
  let completed = 0;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  if (actions.length === 0) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, fileGroups.length) }, async () => {
        for (;;) {
          const group = fileGroups[groupCursor++];
          if (!group) {
            return;
          }
          for (const { file, index } of group) {
            if (dryRun) {
              actions[index] = {
                file: file.file,
                owner: file.owner,
                package: file.package,
                status: 'planned',
                version: file.version,
              };
              completed += 1;
              options.onProgress?.({
                current: completed,
                detail: `planned ${file.filename}`,
                status: 'progress',
                total: files.length,
              });
              continue;
            }
            const onFileProgress = options.onProgress
              ? createPythonFilePublishProgress({
                  current: () => completed,
                  filename: file.filename,
                  onProgress: options.onProgress,
                  total: files.length,
                })
              : undefined;
            const remoteSnapshot = remoteSnapshots.get(giteaGenericPackageVersionKey(file));
            try {
              actions[index] = {
                file: file.file,
                owner: file.owner,
                package: file.package,
                status: await serializeByKey(digestUploadTails, file.expectedSha256, async () =>
                  publishGiteaGenericPackageFile({
                    ...(options.auth ? { auth: options.auth } : {}),
                    baseUrl,
                    bundleDir,
                    fetch: options.fetch ?? globalThis.fetch,
                    file,
                    ...(onFileProgress ? { onProgress: onFileProgress } : {}),
                    ...(remoteSnapshot ? { remoteSnapshot } : {}),
                    timeoutMs,
                  })
                ),
                version: file.version,
              };
            } catch (error) {
              actions[index] = {
                error: (error as Error).message,
                file: file.file,
                owner: file.owner,
                package: file.package,
                status: 'error',
                version: file.version,
              };
            }
            completed += 1;
            const action = actions[index];
            options.onProgress?.({
              current: completed,
              detail: `${action.status} ${file.filename}${action.error ? `: ${action.error}` : ''}`,
              status: 'progress',
              total: files.length,
            });
          }
        }
      })
    );
  } else {
    completed = actions.length;
  }
  const errors = actions.filter((action) => action.status === 'error');
  const report: PythonGenericPublishReport = {
    actions,
    dryRun,
    enabled: true,
    errors,
    generatedAt,
    planned: actions.filter((action) => action.status === 'planned').length,
    publicationId: options.publicationManifest.publicationId,
    published: actions.filter((action) => action.status === 'published').length,
    skipped: actions.filter((action) => action.status === 'skipped').length,
  };
  await fs.writeJson(
    path.join(
      bundleDir,
      dryRun
        ? 'python-application-publish-dry-run-report.json'
        : 'python-application-publish-report.json'
    ),
    report,
    { spaces: 2 }
  );
  options.onProgress?.({
    current: completed,
    ...(errors.length === 0 ? {} : { detail: `${String(errors.length)} errors` }),
    status: errors.length === 0 ? 'done' : 'error',
    total: files.length,
  });
  return report;
}
