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
});
