import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import type { PythonApplicationBundleIndex } from '../../src/core/python/application-bundle.js';
import { publishPythonGenericArtifacts } from '../../src/core/python/generic-publisher.js';
import type { PythonPublishProgressEvent } from '../../src/core/python/publish-progress.js';
import type { PythonPublicationManifest } from '../../src/core/python/publication-manifest.js';

let bundleDir: string;
let server: http.Server | undefined;

async function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

async function writeBundle(
  giteaBaseUrl = 'http://gitea.local'
): Promise<PythonPublicationManifest> {
  const directory = path.join(bundleDir, 'python/applications/demo--desktop-x64');
  const files = {
    'environment-plan.json': '{"schemaVersion":2}\n',
    'plan-diff.json': '{"changed":true}\n',
    'prerequisites.json': '{"platforms":[]}\n',
  };
  for (const [filename, content] of Object.entries(files)) {
    await fs.writeFileAtomic(path.join(directory, filename), content);
  }
  const sourceDocuments = Object.entries(files).map(([filename, content]) => ({
    digest: createHash('sha256').update(content).digest('hex'),
    file: `python/applications/demo--desktop-x64/${filename}`,
  }));
  const toolContent = Buffer.from('uv fixture');
  const toolSha = createHash('sha256').update(toolContent).digest('hex');
  const toolFile = `python/artifacts/optional/tools/uv/${toolSha}/uv.tar.gz`;
  await fs.writeFileAtomic(path.join(bundleDir, toolFile), toolContent);
  const publicationId = 'b'.repeat(64);
  const publicationDirectory = `python/publications/${publicationId}/applications/demo--desktop-x64`;
  const publicationDocuments = [
    'consumer-contract.json',
    'consumer.env.template',
    'pip.conf.template',
  ].map((filename) => {
    const file = `${publicationDirectory}/${filename}`;
    const content = `${file}\n`;
    return {
      content,
      digest: createHash('sha256').update(content).digest('hex'),
      file,
    };
  });
  for (const document of publicationDocuments) {
    await fs.writeFileAtomic(path.join(bundleDir, document.file), document.content);
  }
  const index: PythonApplicationBundleIndex = {
    applications: [
      {
        application: { name: 'demo', version: '1.0.0' },
        artifactIds: [`${toolSha}:uv.tar.gz`],
        branchSizes: [],
        features: {},
        locks: [],
        planDiffPath: 'python/applications/demo--desktop-x64/plan-diff.json',
        planId: 'a'.repeat(64),
        planPath: 'python/applications/demo--desktop-x64/environment-plan.json',
        prerequisiteReportPath: 'python/applications/demo--desktop-x64/prerequisites.json',
        targetId: 'demo--desktop-x64',
      },
    ],
    artifacts: [
      {
        file: toolFile,
        filename: 'uv.tar.gz',
        id: `${toolSha}:uv.tar.gz`,
        kind: 'uv',
        references: [
          {
            platforms: ['linux-glibc-x86_64'],
            targetId: 'demo--desktop-x64',
          },
        ],
        sha256: toolSha,
        size: toolContent.byteLength,
        sourceUrl: 'https://example.test/uv.tar.gz',
        version: '0.11.16',
      },
    ],
    createdAt: '2026-07-27T00:00:00.000Z',
    schemaVersion: 2,
    summary: {
      applications: 1,
      artifacts: 1,
      totalBytes: toolContent.byteLength,
    },
  };
  await fs.writeJsonAtomic(path.join(bundleDir, 'python/application-index.json'), index, {
    spaces: 2,
  });
  return {
    applications: [
      {
        documents: publicationDocuments.map(({ digest, file }) => ({ digest, file })),
        genericPackage: {
          owner: 'python-apps',
          package: 'demo-desktop-x64',
          version: `1.0.0+plan.aaaaaaaaaaaa.pub.${publicationId.slice(0, 12)}`,
        },
        planId: 'a'.repeat(64),
        pypiIndexUrl: `${giteaBaseUrl}/api/packages/pypi/pypi/simple`,
        sourceDocuments,
        targetId: 'demo--desktop-x64',
      },
    ],
    artifacts: [
      {
        artifactId: `${toolSha}:uv.tar.gz`,
        file: toolFile,
        genericPackage: {
          owner: 'python-apps',
          package: 'uv-linux-glibc-x86_64',
          version: '0.11.16',
        },
      },
    ],
    giteaBaseUrl,
    owners: {
      generic: { kind: 'organization', name: 'python-apps' },
      pypi: { kind: 'organization', name: 'pypi' },
    },
    publicationId,
    schemaVersion: 2,
  };
}

beforeEach(async () => {
  bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-generic-publish-'));
});

afterEach(async () => {
  await fs.remove(bundleDir);
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    server = undefined;
  }
});

describe('publishPythonGenericArtifacts', () => {
  it('publishes contracts idempotently with Basic authentication', async () => {
    const published = new Map<string, Buffer>();
    const baseUrl = await listen((request, response) => {
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from('publisher:token').toString('base64')}`
      );
      if (request.method === 'GET') {
        const content = published.get(request.url ?? '');
        response.writeHead(content ? 200 : 404).end(content);
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = request.url ?? '';
        if (published.has(url)) {
          response.writeHead(409).end('already exists');
        } else {
          published.set(url, Buffer.concat(chunks));
          response.writeHead(201).end();
        }
      });
    });
    const publicationManifest = await writeBundle(baseUrl);
    const options = {
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      giteaBaseUrl: baseUrl,
      publicationManifest,
    };

    const progress: PythonPublishProgressEvent[] = [];
    const first = await publishPythonGenericArtifacts({
      ...options,
      onProgress: (event) => progress.push(event),
    });
    const second = await publishPythonGenericArtifacts(options);

    expect(first).toMatchObject({ errors: [], published: 7, skipped: 0 });
    expect(progress[0]).toEqual({ current: 0, status: 'start' });
    const uploadProgress = progress.find(
      (event) => event.bytes === 0 && event.detail?.startsWith('upload ')
    );
    expect(uploadProgress).toMatchObject({
      bytes: 0,
      status: 'progress',
      total: 7,
    });
    expect(typeof uploadProgress?.current).toBe('number');
    expect(typeof uploadProgress?.totalBytes).toBe('number');
    expect(progress.at(-1)).toEqual({ current: 7, status: 'done', total: 7 });
    expect(second).toMatchObject({ errors: [], published: 0, skipped: 7 });
    expect([...published.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '/api/packages/python-apps/generic/demo-desktop-x64/1.0.0%2Bplan.aaaaaaaaaaaa.pub.bbbbbbbbbbbb/environment-plan.json'
        ),
        expect.stringContaining(
          '/api/packages/python-apps/generic/uv-linux-glibc-x86_64/0.11.16/uv.tar.gz'
        ),
      ])
    );
  });

  it('resumes an interrupted publication and verifies already accepted artifacts', async () => {
    const published = new Map<string, Buffer>();
    let interruptPlanDiff = true;
    const baseUrl = await listen((request, response) => {
      const url = request.url ?? '';
      if (request.method === 'GET') {
        const content = published.get(url);
        response.writeHead(content ? 200 : 404).end(content);
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (interruptPlanDiff && url.endsWith('/plan-diff.json')) {
          interruptPlanDiff = false;
          response.writeHead(503).end('injected interruption');
          return;
        }
        if (published.has(url)) {
          response.writeHead(409).end('already exists');
          return;
        }
        published.set(url, Buffer.concat(chunks));
        response.writeHead(201).end();
      });
    });
    const publicationManifest = await writeBundle(baseUrl);
    const options = {
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      concurrency: 1,
      giteaBaseUrl: baseUrl,
      publicationManifest,
    };

    const interrupted = await publishPythonGenericArtifacts(options);
    const recovered = await publishPythonGenericArtifacts(options);

    expect(interrupted.published).toBe(6);
    expect(interrupted.errors).toHaveLength(1);
    expect(interrupted.errors[0]?.file).toContain('plan-diff.json');
    expect(recovered).toMatchObject({
      errors: [],
      published: 1,
      skipped: 6,
    });
    expect(published.size).toBe(7);
  });

  it('serializes initial uploads to the same Gitea package', async () => {
    const activePackages = new Set<string>();
    const published = new Map<string, Buffer>();
    let packageRace = false;
    const baseUrl = await listen((request, response) => {
      const url = request.url ?? '';
      if (request.method === 'GET') {
        const content = published.get(url);
        response.writeHead(content ? 200 : 404).end(content);
        return;
      }
      const packageKey = url.split('/').slice(0, -2).join('/').toLowerCase();
      if (activePackages.has(packageKey)) {
        packageRace = true;
        request.resume();
        response
          .writeHead(500)
          .end('pq: duplicate key value violates unique constraint "UQE_package_s"');
        return;
      }
      activePackages.add(packageKey);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        setTimeout(() => {
          published.set(url, Buffer.concat(chunks));
          activePackages.delete(packageKey);
          response.writeHead(201).end();
        }, 10);
      });
    });
    const publicationManifest = await writeBundle(baseUrl);

    const report = await publishPythonGenericArtifacts({
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      concurrency: 4,
      giteaBaseUrl: baseUrl,
      publicationManifest,
    });

    expect(packageRace).toBe(false);
    expect(report).toMatchObject({ errors: [], published: 7 });
    expect(published.size).toBe(7);
  });

  it('produces a dry-run plan without credentials', async () => {
    const publicationManifest = await writeBundle();
    const report = await publishPythonGenericArtifacts({
      bundleDir,
      dryRun: true,
      giteaBaseUrl: 'http://gitea.local',
      publicationManifest,
    });

    expect(report).toMatchObject({ errors: [], planned: 7, published: 0, skipped: 0 });
  });

  it('explains a Gitea package-registry 404', async () => {
    const baseUrl = await listen((request, response) => {
      request.resume();
      response.writeHead(404).end('Not found');
    });
    const publicationManifest = await writeBundle(baseUrl);

    const report = await publishPythonGenericArtifacts({
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      giteaBaseUrl: baseUrl,
      publicationManifest,
    });

    expect(report.errors[0]?.error).toContain(
      'verify Gitea [packages] ENABLED=true and that the token has package write permission'
    );
  });
});
