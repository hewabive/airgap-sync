import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import type { PythonSeedManifest } from '../../src/core/python/bundle.js';
import {
  assertPythonSecurityGate,
  scanPythonBundleSecurity,
  summarizePythonSecurityReport,
  writePythonSecurityReport,
} from '../../src/core/python/security.js';

const sha256 = 'ab'.repeat(32);
const temporaryDirectories: string[] = [];

function manifest(): PythonSeedManifest {
  return {
    createdAt: '2026-08-09T00:00:00.000Z',
    packages: [
      {
        files: [
          {
            coreMetadata: {
              metadataVersion: '2.4',
              name: 'Demo_Package',
              projectUrls: [],
              providesExtra: [],
              requiresDist: [],
              version: '1.2.3',
            },
            environments: ['prod'],
            file: 'python-packages/demo_package-1.2.3-py3-none-any.whl',
            filename: 'demo_package-1.2.3-py3-none-any.whl',
            kind: 'wheel',
            sha256,
            sourceHashes: { sha256 },
            url: 'https://files.example/demo_package-1.2.3-py3-none-any.whl',
          },
        ],
        name: 'Demo_Package',
        resolvedFrom: [],
        version: '1.2.3',
      },
    ],
    roots: ['Demo_Package==1.2.3'],
    schemaVersion: 1,
    sourceIndex: 'https://pypi.org/simple/',
    targetEnvironments: [],
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => fs.remove(directory)));
});

describe('Python bundle security', () => {
  it('blocks an exact PyPI package version with an OSV malware advisory', async () => {
    const queries: { name: string; version: string }[][] = [];
    const report = await scanPythonBundleSecurity({
      advisoryClient: {
        query: (packages) => {
          queries.push(packages);
          return Promise.resolve([[{ id: 'MAL-2026-1234', summary: 'Known malicious release' }]]);
        },
      },
      manifest: manifest(),
    });

    expect(queries).toEqual([[{ name: 'demo-package', version: '1.2.3' }]]);
    expect(report.ok).toBe(false);
    expect(report.advisories).toEqual([
      expect.objectContaining({
        id: 'MAL-2026-1234',
        name: 'demo-package',
        severity: 'error',
        type: 'malware',
        version: '1.2.3',
      }),
    ]);
    expect(summarizePythonSecurityReport(report).details[0]?.message).toContain(
      'Malware [demo-package==1.2.3] MAL-2026-1234'
    );
  });

  it('reports ordinary vulnerabilities as non-blocking warnings', async () => {
    const report = await scanPythonBundleSecurity({
      advisoryClient: {
        query: () => Promise.resolve([[{ id: 'GHSA-aaaa-bbbb-cccc', summary: 'Fix available' }]]),
      },
      manifest: manifest(),
    });

    expect(report.ok).toBe(true);
    expect(report.advisories[0]).toMatchObject({
      severity: 'warning',
      type: 'vulnerability',
    });
    expect(summarizePythonSecurityReport(report)).toMatchObject({
      blocking: 0,
      details: [],
      warnings: 1,
    });
  });

  it('fails closed when OSV cannot be queried', async () => {
    const report = await scanPythonBundleSecurity({
      advisoryClient: {
        query: () => Promise.reject(new Error('network unavailable')),
      },
      manifest: manifest(),
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(['OSV: network unavailable']);
  });

  it('binds a fresh passing report to the complete wheel manifest', async () => {
    const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-python-security-'));
    temporaryDirectories.push(bundleDir);
    const pythonManifest = manifest();
    const report = await scanPythonBundleSecurity({
      advisoryClient: { query: (packages) => Promise.resolve(packages.map(() => [])) },
      generatedAt: '2026-08-09T00:00:00.000Z',
      manifest: pythonManifest,
      policy: { maxReportAgeHours: 24 },
    });
    await writePythonSecurityReport(bundleDir, report);

    await expect(
      assertPythonSecurityGate(bundleDir, pythonManifest, {
        now: new Date('2026-08-09T12:00:00.000Z'),
      })
    ).resolves.toMatchObject({ ok: true, packageCount: 1 });
    await expect(
      assertPythonSecurityGate(
        bundleDir,
        { ...pythonManifest, roots: ['another-package==1.0'] },
        { now: new Date('2026-08-09T12:00:00.000Z') }
      )
    ).rejects.toThrow('does not match python-seed-manifest.json');
    await expect(
      assertPythonSecurityGate(bundleDir, pythonManifest, {
        now: new Date('2026-08-10T00:00:00.001Z'),
      })
    ).rejects.toThrow('older than 24 hours');
  });
});
