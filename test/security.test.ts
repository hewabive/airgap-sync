import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import { computeFileDigests } from '../src/core/integrity.js';
import {
  assertNpmSecurityGate,
  defaultNpmSecurityPolicy,
  scanNpmBundleSecurity,
  summarizeNpmSecurityReport,
  writeNpmSecurityReport,
  type NpmAdvisoryClient,
} from '../src/core/security.js';
import type { BundleManifest, PackageManifest } from '../src/types.js';

let bundleDir: string;

async function createBundle(packageManifest: PackageManifest): Promise<BundleManifest> {
  const sourceDir = path.join(bundleDir, 'source', 'package');
  const tarballPath = path.join(bundleDir, 'packages', 'demo-1.0.0.tgz');
  await fs.ensureDir(sourceDir);
  await fs.ensureDir(path.dirname(tarballPath));
  await fs.writeJson(path.join(sourceDir, 'package.json'), packageManifest, { spaces: 2 });
  await tar.c({ cwd: path.join(bundleDir, 'source'), file: tarballPath, gzip: true }, ['package']);
  const digests = await computeFileDigests(tarballPath);
  return {
    createdAt: '2026-08-09T00:00:00.000Z',
    packages: [
      {
        file: 'packages/demo-1.0.0.tgz',
        name: 'demo',
        resolvedFrom: [],
        sha256: digests.sha256,
        tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
        version: '1.0.0',
      },
    ],
    schemaVersion: 2,
    sourceRegistry: 'https://registry.example',
  };
}

function advisoryClient(
  vulnerabilities: Awaited<ReturnType<NpmAdvisoryClient['query']>>[number]
): NpmAdvisoryClient {
  return {
    query(packages) {
      return Promise.resolve(packages.map(() => vulnerabilities));
    },
  };
}

describe('npm security gate', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-security-'));
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('blocks malware advisories for exact package versions', async () => {
    const manifest = await createBundle({ name: 'demo', version: '1.0.0' });
    const report = await scanNpmBundleSecurity({
      advisoryClient: advisoryClient([{ id: 'MAL-2026-1234', summary: 'Malicious package' }]),
      bundleDir,
      manifest,
    });

    expect(report.ok).toBe(false);
    expect(report.advisories).toContainEqual(
      expect.objectContaining({ id: 'MAL-2026-1234', severity: 'error', type: 'malware' })
    );
  });

  it('blocks preinstall and non-registry dependencies but allows a digest-pinned exception', async () => {
    const manifest = await createBundle({
      name: 'demo',
      optionalDependencies: { setup: 'github:example/setup#main' },
      scripts: { preinstall: 'node setup.js' },
      version: '1.0.0',
    });
    const cleanClient = advisoryClient([]);
    const blocked = await scanNpmBundleSecurity({
      advisoryClient: cleanClient,
      bundleDir,
      manifest,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.staticFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'scripts.preinstall', severity: 'error' }),
        expect.objectContaining({
          field: 'optionalDependencies.setup',
          severity: 'error',
        }),
      ])
    );

    const pkg = manifest.packages[0];
    const allowed = await scanNpmBundleSecurity({
      advisoryClient: cleanClient,
      bundleDir,
      manifest,
      policy: { allowPackages: [`demo@1.0.0#sha256:${pkg?.sha256 ?? ''}`] },
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.staticFindings.every((finding) => finding.allowed)).toBe(true);
  });

  it('reports ordinary vulnerabilities without treating them as malware', async () => {
    const manifest = await createBundle({ name: 'demo', version: '1.0.0' });
    const report = await scanNpmBundleSecurity({
      advisoryClient: advisoryClient([{ id: 'GHSA-xxxx-yyyy-zzzz' }]),
      bundleDir,
      manifest,
    });

    expect(report.ok).toBe(true);
    expect(report.advisories[0]).toMatchObject({
      severity: 'warning',
      type: 'vulnerability',
    });
  });

  it('fails closed when OSV cannot be queried', async () => {
    const manifest = await createBundle({ name: 'demo', version: '1.0.0' });
    const report = await scanNpmBundleSecurity({
      advisoryClient: {
        query() {
          return Promise.reject(new Error('network unavailable'));
        },
      },
      bundleDir,
      manifest,
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain('OSV: network unavailable');
  });

  it('builds a bounded console summary with actionable package identities', () => {
    const summary = summarizeNpmSecurityReport(
      {
        advisories: [
          {
            aliases: [],
            id: 'MAL-2026-1234',
            name: 'malicious-demo',
            severity: 'error',
            summary: 'Malicious package',
            type: 'malware',
            version: '1.0.0',
          },
          {
            aliases: [],
            id: 'GHSA-xxxx-yyyy-zzzz',
            name: 'vulnerable-demo',
            severity: 'warning',
            type: 'vulnerability',
            version: '2.0.0',
          },
        ],
        errors: ['OSV mirror returned incomplete data'],
        generatedAt: '2026-08-09T00:00:00.000Z',
        manifestSha256: 'abc',
        ok: false,
        packageCount: 2,
        policy: defaultNpmSecurityPolicy,
        provider: { name: 'OSV', url: 'https://api.osv.dev/v1/querybatch' },
        schemaVersion: 1,
        staticFindings: [
          {
            allowed: false,
            field: 'scripts.postinstall',
            message: 'demo@1.0.0 declares postinstall lifecycle code',
            name: 'demo',
            severity: 'error',
            sha256: 'def',
            type: 'lifecycle-script',
            value: 'node setup.js',
            version: '1.0.0',
          },
        ],
      },
      { maxDetails: 2 }
    );

    expect(summary).toMatchObject({
      blocking: 3,
      blockingAdvisories: 1,
      blockingStatic: 1,
      omitted: 2,
      scannerErrors: 1,
      warnings: 1,
    });
    expect(summary.details).toEqual([
      { level: 'error', message: 'Scanner error: OSV mirror returned incomplete data' },
      {
        level: 'error',
        message: 'Malware [malicious-demo@1.0.0] MAL-2026-1234: Malicious package',
      },
    ]);
  });

  it('requires a fresh report bound to the exact manifest', async () => {
    const manifest = await createBundle({ name: 'demo', version: '1.0.0' });
    const report = await scanNpmBundleSecurity({
      advisoryClient: advisoryClient([]),
      bundleDir,
      generatedAt: '2026-08-09T00:00:00.000Z',
      manifest,
      policy: { maxReportAgeHours: 24 },
    });
    await writeNpmSecurityReport(bundleDir, report);

    await expect(
      assertNpmSecurityGate(bundleDir, manifest, { now: new Date('2026-08-09T12:00:00.000Z') })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      assertNpmSecurityGate(bundleDir, manifest, { now: new Date('2026-08-11T00:00:00.000Z') })
    ).rejects.toThrow('security report is older');
    await expect(
      assertNpmSecurityGate(bundleDir, {
        ...manifest,
        createdAt: '2026-08-09T00:01:00.000Z',
      })
    ).rejects.toThrow('does not match');
  });
});
