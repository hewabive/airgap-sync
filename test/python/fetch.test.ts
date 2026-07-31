import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import { resolveTargetEnvironment } from '../../src/core/python/environments.js';
import { fetchPythonBundle } from '../../src/core/python/fetch.js';
import { PythonMetadataCache } from '../../src/core/python/metadata.js';
import type { PythonResolutionResult } from '../../src/core/python/resolution-types.js';
import { createStoredZip } from './zip-fixture.js';

let tempDir: string;
const servers: http.Server[] = [];

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-python-fetch-'));
});

afterEach(async () => {
  await fs.remove(tempDir);
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        })
    )
  );
});

async function serve(body: Buffer): Promise<string> {
  const server = http.createServer((_request, response) => response.end(body));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}/demo-1.0-py3-none-any.whl`;
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

const configs = [
  {
    arch: 'x86_64' as const,
    manylinux: 'manylinux_2_17',
    name: 'linux',
    os: 'linux' as const,
    pythonVersion: '3.11.9',
  },
  {
    arch: 'x86_64' as const,
    name: 'windows',
    os: 'windows' as const,
    pythonVersion: '3.12.4',
  },
];

function resolution(url: string, hash: string, size: number): PythonResolutionResult {
  const environments = configs.map(resolveTargetEnvironment);
  return {
    approximate: false,
    artifacts: environments.map((environment) => ({
      approximate: false,
      environment: environment.name,
      file: {
        filename: 'demo-1.0-py3-none-any.whl',
        hashes: { sha256: hash },
        size,
        url,
      },
      name: 'demo',
      reasons: [
        {
          raw: 'demo==1.0',
          requiredBy: 'lockfile:uv.lock',
          sourcePath: 'uv.lock',
          type: 'locked',
        },
      ],
      version: '1.0',
    })),
    environments,
    errors: [],
  };
}

describe('fetchPythonBundle', () => {
  it('downloads once for multiple environments, verifies it, and builds a manifest', async () => {
    const wheel = createStoredZip([
      {
        data: Buffer.from('Metadata-Version: 2.4\nName: demo\nVersion: 1.0\n'),
        name: 'demo-1.0.dist-info/METADATA',
      },
    ]);
    const url = await serve(wheel);
    const first = await fetchPythonBundle({
      bundleDir: tempDir,
      cache: new PythonMetadataCache(),
      resolution: resolution(url, sha256(wheel), wheel.length),
      roots: ['demo==1.0'],
      sourceIndex: 'https://pypi.org/simple',
      targetEnvironments: configs,
    });

    expect(first.report).toMatchObject({ downloaded: 1, errors: [], resolvedFiles: 1, skipped: 0 });
    expect(first.manifest?.packages[0]?.files[0]).toMatchObject({
      environments: ['linux', 'windows'],
      filename: 'demo-1.0-py3-none-any.whl',
    });
    expect(
      await fs.pathExists(path.join(tempDir, 'python-packages/demo-1.0-py3-none-any.whl'))
    ).toBe(true);

    const second = await fetchPythonBundle({
      bundleDir: tempDir,
      cache: new PythonMetadataCache(),
      resolution: resolution(url, sha256(wheel), wheel.length),
      sourceIndex: 'https://pypi.org/simple',
      targetEnvironments: configs,
    });
    expect(second.report).toMatchObject({ downloaded: 0, errors: [], skipped: 1 });
  });

  it('plans without writing and rejects hash mismatches', async () => {
    const wheel = createStoredZip([
      {
        data: Buffer.from('Metadata-Version: 2.4\nName: demo\nVersion: 1.0\n'),
        name: 'demo-1.0.dist-info/METADATA',
      },
    ]);
    const url = await serve(wheel);
    const planned = await fetchPythonBundle({
      bundleDir: tempDir,
      cache: new PythonMetadataCache(),
      dryRun: true,
      resolution: resolution(url, sha256(wheel), wheel.length),
      sourceIndex: 'https://pypi.org/simple',
      targetEnvironments: configs,
    });
    expect(planned.report.planned).toBe(1);
    expect(await fs.pathExists(path.join(tempDir, 'python-packages'))).toBe(false);

    const failed = await fetchPythonBundle({
      bundleDir: tempDir,
      cache: new PythonMetadataCache(),
      resolution: resolution(url, '00'.repeat(32), wheel.length),
      retryDelaysMs: [],
      sourceIndex: 'https://pypi.org/simple',
      targetEnvironments: configs,
    });
    expect(failed.manifest).toBeUndefined();
    expect(failed.report.errors[0]?.reason).toContain('sha256 mismatch');
  });

  it('downloads independent wheels concurrently', async () => {
    const firstWheel = createStoredZip([
      {
        data: Buffer.from('Metadata-Version: 2.4\nName: first\nVersion: 1.0\n'),
        name: 'first-1.0.dist-info/METADATA',
      },
    ]);
    const secondWheel = createStoredZip([
      {
        data: Buffer.from('Metadata-Version: 2.4\nName: second\nVersion: 2.0\n'),
        name: 'second-2.0.dist-info/METADATA',
      },
    ]);
    const bodies = new Map([
      ['/first-1.0-py3-none-any.whl', firstWheel],
      ['/second-2.0-py3-none-any.whl', secondWheel],
    ]);
    const pending: { body: Buffer; response: http.ServerResponse }[] = [];
    let maxActive = 0;
    const server = http.createServer((request, response) => {
      const body = bodies.get(request.url ?? '');
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      pending.push({ body, response });
      maxActive = Math.max(maxActive, pending.length);
      if (pending.length === 2) {
        pending.splice(0).forEach((entry) => entry.response.end(entry.body));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;
    const environments = configs.map(resolveTargetEnvironment);
    const resolved: PythonResolutionResult = {
      approximate: false,
      artifacts: [
        {
          approximate: false,
          environment: environments[0]!.name,
          file: {
            filename: 'first-1.0-py3-none-any.whl',
            hashes: { sha256: sha256(firstWheel) },
            size: firstWheel.length,
            url: `${baseUrl}/first-1.0-py3-none-any.whl`,
          },
          name: 'first',
          reasons: [
            {
              raw: 'first==1.0',
              requiredBy: 'root',
              sourcePath: 'requirements.txt',
              type: 'requirement',
            },
          ],
          version: '1.0',
        },
        {
          approximate: false,
          environment: environments[1]!.name,
          file: {
            filename: 'second-2.0-py3-none-any.whl',
            hashes: { sha256: sha256(secondWheel) },
            size: secondWheel.length,
            url: `${baseUrl}/second-2.0-py3-none-any.whl`,
          },
          name: 'second',
          reasons: [
            {
              raw: 'second==2.0',
              requiredBy: 'root',
              sourcePath: 'requirements.txt',
              type: 'requirement',
            },
          ],
          version: '2.0',
        },
      ],
      environments,
      errors: [],
    };

    const result = await fetchPythonBundle({
      bundleDir: tempDir,
      cache: new PythonMetadataCache(),
      concurrency: 2,
      resolution: resolved,
      sourceIndex: 'https://pypi.org/simple',
      targetEnvironments: configs,
    });

    expect(maxActive).toBe(2);
    expect(result.report).toMatchObject({ downloaded: 2, errors: [] });
  });
});
