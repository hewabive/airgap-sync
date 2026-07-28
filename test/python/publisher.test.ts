import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import type { PythonSeedManifest } from '../../src/core/python/bundle.js';
import { publishPythonBundle } from '../../src/core/python/publisher.js';
import type { PythonPublishProgressEvent } from '../../src/core/python/publish-progress.js';

let bundleDir: string;
let server: http.Server | undefined;
const wheel = Buffer.from('wheel bytes');
const hash = createHash('sha256').update(wheel).digest('hex');

function manifest(): PythonSeedManifest {
  return {
    schemaVersion: 1,
    createdAt: '2026-07-10T00:00:00.000Z',
    packages: [
      {
        files: [
          {
            coreMetadata: {
              metadataVersion: '2.4',
              name: 'Demo_Package',
              projectUrls: ['Homepage, https://example.test'],
              providesExtra: [],
              requiresDist: ['child>=1'],
              requiresPython: '>=3.10',
              version: '1.0',
            },
            environments: ['prod'],
            file: 'python-packages/demo_package-1.0-py3-none-any.whl',
            filename: 'demo_package-1.0-py3-none-any.whl',
            kind: 'wheel',
            sha256: hash,
            sourceHashes: { sha256: hash },
            url: 'https://files.example/demo_package-1.0-py3-none-any.whl',
          },
        ],
        name: 'demo-package',
        resolvedFrom: [],
        version: '1.0',
      },
    ],
    roots: ['demo-package==1.0'],
    sourceIndex: 'https://pypi.org/simple/',
    targetEnvironments: [],
  };
}

async function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

beforeEach(async () => {
  bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-python-publish-'));
  await fs.ensureDir(path.join(bundleDir, 'python-packages'));
  await fs.writeFile(
    path.join(bundleDir, 'python-packages/demo_package-1.0-py3-none-any.whl'),
    wheel
  );
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

describe('publishPythonBundle', () => {
  it('streams a legacy multipart upload with Basic authentication', async () => {
    let received = Buffer.alloc(0);
    const progress: PythonPublishProgressEvent[] = [];
    const baseUrl = await listen((request, response) => {
      expect(request.url).toBe('/api/packages/public/pypi');
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from('publisher:token').toString('base64')}`
      );
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received = Buffer.concat(chunks);
        response.writeHead(201).end();
      });
    });

    const report = await publishPythonBundle(manifest(), {
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      giteaBaseUrl: baseUrl,
      onProgress: (event) => progress.push(event),
      owner: 'public',
    });

    expect(report).toMatchObject({ errors: [], published: 1, skipped: 0 });
    expect(progress[0]).toEqual({ current: 0, status: 'start', total: 1 });
    expect(progress).toContainEqual({
      bytes: 0,
      current: 0,
      detail: 'upload demo_package-1.0-py3-none-any.whl',
      status: 'progress',
      total: 1,
      totalBytes: wheel.byteLength,
    });
    expect(progress).toContainEqual({
      current: 1,
      detail: 'published demo_package-1.0-py3-none-any.whl',
      status: 'progress',
      total: 1,
    });
    expect(progress.at(-1)).toEqual({ current: 1, status: 'done', total: 1 });
    expect(received.includes(wheel)).toBe(true);
    expect(received.toString()).toContain('name="sha256_digest"');
    expect(received.toString()).toContain(hash);
  });

  it('accepts a 409 only when the existing wheel has the bundled sha256', async () => {
    const baseUrl = await listen((request, response) => {
      if (request.method === 'POST') {
        request.resume();
        response.writeHead(409).end('already exists');
        return;
      }
      expect(request.url).toBe(
        '/api/packages/public/pypi/files/demo-package/1.0/demo_package-1.0-py3-none-any.whl'
      );
      response.writeHead(200).end(wheel);
    });

    const report = await publishPythonBundle(manifest(), {
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      giteaBaseUrl: baseUrl,
      owner: 'public',
    });

    expect(report).toMatchObject({ errors: [], published: 0, skipped: 1 });
  });

  it('plans without credentials or reading wheel files', async () => {
    await fs.remove(path.join(bundleDir, 'python-packages'));
    const report = await publishPythonBundle(manifest(), {
      bundleDir,
      dryRun: true,
      giteaBaseUrl: 'http://gitea.local',
      owner: 'public',
    });
    expect(report).toMatchObject({ planned: 1, published: 0, skipped: 0 });
  });

  it('explains a Gitea package-registry 404', async () => {
    const baseUrl = await listen((request, response) => {
      request.resume();
      response.writeHead(404).end('Not found');
    });

    const report = await publishPythonBundle(manifest(), {
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      giteaBaseUrl: baseUrl,
      owner: 'public',
    });

    expect(report.errors[0]?.error).toContain(
      'verify Gitea [packages] ENABLED=true and that the token has package write permission'
    );
  });
});
