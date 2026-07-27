import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { semanticDigest } from '../canonical-json.js';
import * as fs from '../fs.js';
import {
  readPythonApplicationBundleIndex,
  type PythonApplicationBundleIndex,
} from './application-bundle.js';
import type { PythonConsumerContract } from './consumer-contract.js';
import type { PythonEnvironmentPlan } from './environment-plan.js';

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
  timeoutMs?: number;
}

interface GenericFile {
  expectedSha256?: string;
  file: string;
  filename: string;
  owner: string;
  package: string;
  version: string;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Gitea URL must use HTTP or HTTPS: ${value}`);
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/u, '');
}

function validateCoordinate(value: string, description: string): string {
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

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
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

function genericUrl(baseUrl: string, file: GenericFile): string {
  return `${baseUrl}/api/packages/${encodeURIComponent(file.owner)}/generic/${encodeURIComponent(file.package)}/${encodeURIComponent(file.version)}/${encodeURIComponent(file.filename)}`;
}

async function remoteMatches(options: {
  auth?: PythonGenericPublishAuth;
  expectedSha256: string;
  fetch: typeof globalThis.fetch;
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
  for await (const chunk of Readable.fromWeb(response.body)) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return hash.digest('hex') === options.expectedSha256;
}

async function publishFile(options: {
  auth?: PythonGenericPublishAuth;
  baseUrl: string;
  bundleDir: string;
  fetch: typeof globalThis.fetch;
  file: GenericFile;
  timeoutMs: number;
}): Promise<'published' | 'skipped'> {
  const filePath = safeFile(options.bundleDir, options.file.file);
  const digest = await sha256(filePath);
  if (options.file.expectedSha256 && digest !== options.file.expectedSha256) {
    throw new Error(`bundle sha256 mismatch for ${options.file.file}`);
  }
  const url = genericUrl(options.baseUrl, options.file);
  const response = await options.fetch(url, {
    body: fs.createReadStream(filePath),
    duplex: 'half',
    headers: {
      ...authHeaders(options.auth),
      'Content-Length': String((await fs.stat(filePath)).size),
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
    if (
      await remoteMatches({
        ...(options.auth ? { auth: options.auth } : {}),
        expectedSha256: digest,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        url,
      })
    ) {
      return 'skipped';
    }
    throw new Error('Gitea reports a conflict, but the existing generic artifact differs');
  }
  const detail = (await response.text()).trim().slice(0, 500);
  throw new Error(
    `Gitea Generic Package upload failed with HTTP ${String(response.status)}${detail ? `: ${detail}` : ''}`
  );
}

async function applicationFiles(
  bundleDir: string,
  index: PythonApplicationBundleIndex,
  giteaBaseUrl: string
): Promise<GenericFile[]> {
  const files: GenericFile[] = [];
  for (const application of index.applications) {
    const contractPath = safeFile(bundleDir, application.consumerContractPath);
    const contractContent = await fs.readFile(contractPath, 'utf8');
    const contract = await fs.readJson<PythonConsumerContract>(contractPath);
    if (
      contract.generatedFromPlanId !== application.planId ||
      semanticDigest(contractContent) !==
        application.consumerDocumentDigests[application.consumerContractPath]
    ) {
      throw new Error(`Python consumer contract does not match ${application.targetId}`);
    }
    const plan = await fs.readJson<PythonEnvironmentPlan>(
      safeFile(bundleDir, application.planPath)
    );
    if (!plan.publication) {
      throw new Error(`Python application ${application.targetId} has no publication contract`);
    }
    const expectedIndexUrl = `${normalizeBaseUrl(giteaBaseUrl)}/api/packages/${encodeURIComponent(plan.publication.pythonPackageOwner)}/pypi/simple`;
    if (contract.configuration.indexUrl !== expectedIndexUrl) {
      throw new Error(
        `Python application ${application.targetId} consumer index ${contract.configuration.indexUrl} does not match publish destination ${expectedIndexUrl}; update workspace giteaUrl and download the immutable plan again`
      );
    }
    if (!contract.publication) {
      throw new Error(
        `Python application ${application.targetId} has no generic publication coordinates; replan with python.applicationArtifactOwner configured`
      );
    }
    const documentPaths = [
      application.planPath,
      application.planDiffPath,
      application.prerequisiteReportPath,
      application.consumerContractPath,
      ...application.consumerConfigurationPaths,
      ...application.locks.map((lock) => lock.file),
    ];
    for (const file of [...new Set(documentPaths)]) {
      files.push({
        file,
        filename: validateCoordinate(path.posix.basename(file), 'filename'),
        owner: validateCoordinate(contract.publication.owner, 'owner'),
        package: validateCoordinate(contract.publication.package, 'package name'),
        version: validateCoordinate(contract.publication.version, 'version'),
      });
    }
  }
  return files;
}

function optionalArtifactFiles(index: PythonApplicationBundleIndex): GenericFile[] {
  return index.artifacts.flatMap((artifact) =>
    artifact.kind === 'wheel' || !artifact.publication
      ? []
      : [
          {
            expectedSha256: artifact.sha256,
            file: artifact.file,
            filename: validateCoordinate(artifact.filename, 'filename'),
            owner: validateCoordinate(artifact.publication.owner, 'owner'),
            package: validateCoordinate(artifact.publication.package, 'package name'),
            version: validateCoordinate(artifact.publication.version, 'version'),
          },
        ]
  );
}

export async function publishPythonGenericArtifacts(
  options: PublishPythonGenericArtifactsOptions
): Promise<PythonGenericPublishReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const dryRun = options.dryRun === true;
  const index = await readPythonApplicationBundleIndex(bundleDir);
  if (!index) {
    return {
      actions: [],
      dryRun,
      enabled: false,
      errors: [],
      generatedAt,
      planned: 0,
      published: 0,
      skipped: 0,
    };
  }
  let files: GenericFile[];
  try {
    files = [
      ...(await applicationFiles(bundleDir, index, options.giteaBaseUrl)),
      ...optionalArtifactFiles(index),
    ].sort(
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
    return report;
  }
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
  let cursor = 0;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  if (actions.length === 0) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, files.length) }, async () => {
        for (;;) {
          const index = cursor++;
          const file = files[index];
          if (!file) {
            return;
          }
          if (dryRun) {
            actions[index] = {
              file: file.file,
              owner: file.owner,
              package: file.package,
              status: 'planned',
              version: file.version,
            };
            continue;
          }
          try {
            actions[index] = {
              file: file.file,
              owner: file.owner,
              package: file.package,
              status: await publishFile({
                ...(options.auth ? { auth: options.auth } : {}),
                baseUrl: normalizeBaseUrl(options.giteaBaseUrl),
                bundleDir,
                fetch: options.fetch ?? globalThis.fetch,
                file,
                timeoutMs: options.timeoutMs ?? 300_000,
              }),
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
        }
      })
    );
  }
  const errors = actions.filter((action) => action.status === 'error');
  const report: PythonGenericPublishReport = {
    actions,
    dryRun,
    enabled: true,
    errors,
    generatedAt,
    planned: actions.filter((action) => action.status === 'planned').length,
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
  return report;
}
