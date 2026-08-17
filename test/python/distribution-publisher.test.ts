import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as fs from '../../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadCpythonDistributionBundle,
  publishCpythonDistributions,
  type CpythonDistributionCandidate,
  type WorkspaceCpythonDistributionsTarget,
} from '../../src/index.js';

let bundleDir: string;
let server: http.Server | undefined;

const content = Buffer.from('portable CPython archive');
const filename = 'cpython-3.12.13+20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz';

function target(): WorkspaceCpythonDistributionsTarget {
  return {
    builds: { windowDays: 30 },
    patches: { latest: 1 },
    platforms: ['linux-glibc-x86_64'],
    provider: 'python-build-standalone',
    series: { from: '3.12', major: 3, through: 'latest-stable' },
    type: 'cpython-distributions',
  };
}

function candidate(
  options: {
    content?: Buffer;
    filename?: string;
    pythonVersion?: string;
  } = {}
): CpythonDistributionCandidate {
  const candidateContent = options.content ?? content;
  const candidateFilename = options.filename ?? filename;
  return {
    filename: candidateFilename,
    platformFamilyId: 'linux-glibc-x86_64',
    provider: 'python-build-standalone',
    providerBuild: '20260805',
    providerPublishedAt: '2026-08-05T00:00:00.000Z',
    pythonVersion: options.pythonVersion ?? '3.12.13',
    sha256: createHash('sha256').update(candidateContent).digest('hex'),
    size: candidateContent.length,
    sourceUrl: `https://github.example/${candidateFilename}`,
  };
}

async function writeBundle(
  candidates: CpythonDistributionCandidate[] = [candidate()],
  contents: ReadonlyMap<string, Buffer> = new Map([[filename, content]])
): Promise<void> {
  await downloadCpythonDistributionBundle({
    bundleDir,
    candidates,
    fetch: (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const candidateContent = contents.get(path.posix.basename(new URL(url).pathname));
      if (!candidateContent) {
        return Promise.reject(new Error(`Unexpected CPython distribution URL: ${url}`));
      }
      return Promise.resolve(
        new Response(candidateContent, {
          headers: { 'content-length': String(candidateContent.length) },
        })
      );
    },
    generatedAt: '2026-08-06T00:00:00.000Z',
    targets: [target()],
  });
}

async function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('CPython distribution publication', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-cpython-publish-'));
    await writeBundle();
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      server = undefined;
    }
  });

  it('publishes additively and skips exact content already present in Gitea', async () => {
    const published = new Map<string, Buffer>();
    const baseUrl = await listen((request, response) => {
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from('publisher:token').toString('base64')}`
      );
      const url = request.url ?? '';
      if (request.method === 'GET') {
        const existing = published.get(url);
        response.writeHead(existing ? 200 : 404).end(existing);
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (published.has(url)) {
          response.writeHead(409).end('already exists');
        } else {
          published.set(url, Buffer.concat(chunks));
          response.writeHead(201).end();
        }
      });
    });
    const options = {
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      giteaBaseUrl: baseUrl,
      owner: 'airgap-packages',
    };

    const first = await publishCpythonDistributions(options);
    const second = await publishCpythonDistributions(options);

    expect(first).toMatchObject({ errors: [], published: 1, skipped: 0 });
    expect(second).toMatchObject({ errors: [], published: 0, skipped: 1 });
    expect([...published.keys()]).toEqual([
      `/api/packages/airgap-packages/generic/python-build-standalone/20260805/${encodeURIComponent(filename)}`,
    ]);
  });

  it('serializes initial uploads to the same Gitea package version', async () => {
    const alternateContent = Buffer.from('alternate portable CPython archive');
    const alternateFilename =
      'cpython-3.13.6+20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz';
    await writeBundle(
      [
        candidate(),
        candidate({
          content: alternateContent,
          filename: alternateFilename,
          pythonVersion: '3.13.6',
        }),
      ],
      new Map([
        [filename, content],
        [alternateFilename, alternateContent],
      ])
    );
    const activeCoordinates = new Set<string>();
    const published = new Map<string, Buffer>();
    let packageRace = false;
    const baseUrl = await listen((request, response) => {
      const url = request.url ?? '';
      if (request.method === 'GET') {
        const existing = published.get(url);
        response.writeHead(existing ? 200 : 404).end(existing);
        return;
      }
      const coordinate = url.split('/').slice(0, -1).join('/').toLowerCase();
      if (activeCoordinates.has(coordinate)) {
        packageRace = true;
        request.resume();
        response
          .writeHead(500)
          .end('pq: duplicate key value violates unique constraint "UQE_package_s"');
        return;
      }
      activeCoordinates.add(coordinate);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        setTimeout(() => {
          published.set(url, Buffer.concat(chunks));
          activeCoordinates.delete(coordinate);
          response.writeHead(201).end();
        }, 10);
      });
    });

    const report = await publishCpythonDistributions({
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      concurrency: 4,
      giteaBaseUrl: baseUrl,
      owner: 'airgap-packages',
    });

    expect(packageRace).toBe(false);
    expect(report).toMatchObject({ errors: [], published: 2, skipped: 0 });
    expect(published.size).toBe(2);
  });

  it('reports a conflict when the immutable remote coordinate has different content', async () => {
    const baseUrl = await listen((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200).end('different archive');
      } else {
        request.resume();
        request.on('end', () => response.writeHead(409).end('already exists'));
      }
    });

    const report = await publishCpythonDistributions({
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      giteaBaseUrl: baseUrl,
      owner: 'airgap-packages',
    });

    expect(report).toMatchObject({ published: 0, skipped: 0 });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.status).toBe('error');
    expect(report.errors[0]?.error).toContain('existing generic artifact differs');
  });
});
