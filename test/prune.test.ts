import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneBundle } from '../src/core/prune.js';
import type { BundleManifest, CollectReport, GitSourcesManifest } from '../src/types.js';

let bundleDir: string;

const generatedAt = '2026-05-24T00:00:00.000Z';

const manifest: BundleManifest = {
  schemaVersion: 1,
  createdAt: generatedAt,
  sourceRegistry: 'https://registry.example',
  packages: [
    {
      name: 'kept',
      version: '1.0.0',
      file: 'packages/kept-1.0.0.tgz',
      tarball: 'https://registry.example/kept/-/kept-1.0.0.tgz',
      resolvedFrom: [],
    },
  ],
};

const gitSources: GitSourcesManifest = {
  schemaVersion: 1,
  createdAt: generatedAt,
  skipped: [],
  sources: [
    {
      host: 'github.com',
      id: 'github.com/acme/kept',
      localMirrorPath: 'git-mirrors/github.com/acme/kept.git',
      owner: 'acme',
      repo: 'kept',
      requirements: [],
      sourceUrl: 'https://github.com/acme/kept.git',
      target: true,
    },
  ],
};

function collectReport(overrides: Partial<CollectReport> = {}): CollectReport {
  return {
    dryRun: false,
    fetch: {
      downloaded: 1,
      errors: [],
      generatedAt,
      gitRequirements: [],
      resolved: 1,
      skipped: 0,
      timings: {
        dependencyScanMs: 0,
        downloadMs: 0,
        manifestReadMs: 0,
        resolveMs: 0,
        totalMs: 0,
      },
      unsupported: [],
    },
    fixedPoint: true,
    generatedAt,
    gitFetch: {
      actions: [],
      changed: 0,
      cloned: 0,
      dryRun: false,
      errors: [],
      generatedAt,
      mirrorsDir: '/bundle/git-mirrors',
      planned: 0,
      totalRepositories: 1,
      unchanged: 1,
      updated: 0,
    },
    gitManifestScanErrors: [],
    gitSources,
    iterations: [],
    maxIterationsReached: false,
    outputDir: '/bundle',
    registryUrl: 'https://registry.example',
    repositoryUpdate: {
      detached: 0,
      dirty: 0,
      dryRun: false,
      errors: [],
      generatedAt,
      planned: 0,
      repositories: [],
      root: '/bundle',
      totalRepositories: 0,
      updated: 0,
    },
    root: '/bundle',
    timings: {
      bundleDocumentsMs: 0,
      fetchIterationsMs: 0,
      gitFetchMs: 0,
      gitManifestScanMs: 0,
      lockfileScanMs: 0,
      manifestScanMs: 0,
      repositoryUpdateMs: 0,
      reportWriteMs: 0,
      totalMs: 0,
    },
    wroteBundle: true,
    ...overrides,
  };
}

async function writeBundleFiles(report: CollectReport = collectReport()): Promise<void> {
  await fs.ensureDir(path.join(bundleDir, 'packages'));
  await fs.ensureDir(path.join(bundleDir, 'git-mirrors/github.com/acme/kept.git'));
  await fs.ensureDir(path.join(bundleDir, 'git-mirrors/github.com/acme/stale.git'));
  await fs.writeFile(path.join(bundleDir, 'packages/kept-1.0.0.tgz'), 'kept');
  await fs.writeFile(path.join(bundleDir, 'packages/stale-1.0.0.tgz'), 'stale');
  await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), manifest, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'git-sources.json'), gitSources, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'collect-report.json'), report, { spaces: 2 });
}

describe('pruneBundle', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-prune-'));
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('removes tarballs and Git mirrors not referenced by the current bundle documents', async () => {
    await writeBundleFiles();

    const report = await pruneBundle({ bundleDir });

    expect(report).toMatchObject({
      dryRun: false,
      gitMirrors: {
        kept: 1,
        removed: 1,
        stale: 1,
        total: 2,
      },
      npmPackages: {
        kept: 1,
        removed: 1,
        stale: 1,
        total: 2,
      },
      planned: 2,
      removed: 2,
    });
    await expect(fs.pathExists(path.join(bundleDir, 'packages/kept-1.0.0.tgz'))).resolves.toBe(
      true
    );
    await expect(fs.pathExists(path.join(bundleDir, 'packages/stale-1.0.0.tgz'))).resolves.toBe(
      false
    );
    await expect(
      fs.pathExists(path.join(bundleDir, 'git-mirrors/github.com/acme/kept.git'))
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(bundleDir, 'git-mirrors/github.com/acme/stale.git'))
    ).resolves.toBe(false);
  });

  it('plans stale objects without removing them in dry-run mode', async () => {
    await writeBundleFiles();

    const report = await pruneBundle({ bundleDir, dryRun: true });

    expect(report).toMatchObject({
      dryRun: true,
      planned: 2,
      removed: 0,
    });
    expect(report.actions.map((action) => action.status)).toEqual(['planned', 'planned']);
    await expect(fs.pathExists(path.join(bundleDir, 'packages/stale-1.0.0.tgz'))).resolves.toBe(
      true
    );
    await expect(
      fs.pathExists(path.join(bundleDir, 'git-mirrors/github.com/acme/stale.git'))
    ).resolves.toBe(true);
  });

  it('refuses to prune after an incomplete download', async () => {
    await writeBundleFiles(collectReport({ fixedPoint: false, wroteBundle: false }));

    await expect(pruneBundle({ bundleDir })).rejects.toThrow(
      'Refusing to prune: the last download did not complete successfully'
    );
    await expect(fs.pathExists(path.join(bundleDir, 'packages/stale-1.0.0.tgz'))).resolves.toBe(
      true
    );
  });
});
