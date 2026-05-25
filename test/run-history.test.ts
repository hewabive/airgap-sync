import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureBundleState, writeDownloadRunHistory } from '../src/index.js';
import type { BundleManifest, BundlePruneReport, CollectReport, DistTagsManifest } from '../src/types.js';

let bundleDir: string;

const beforeManifest: BundleManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-25T00:00:00.000Z',
  sourceRegistry: 'https://registry.example',
  packages: [
    {
      file: 'packages/demo-1.0.0.tgz',
      name: 'demo',
      resolvedFrom: [
        {
          raw: 'demo@^1.0.0',
          requiredBy: 'parent@1.0.0',
          specifier: '^1.0.0',
          type: 'range',
        },
      ],
      tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
      version: '1.0.0',
    },
    {
      file: 'packages/parent-1.0.0.tgz',
      name: 'parent',
      resolvedFrom: [],
      tarball: 'https://registry.example/parent/-/parent-1.0.0.tgz',
      version: '1.0.0',
    },
  ],
};

const distTags: DistTagsManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-25T00:00:00.000Z',
  sourceRegistry: 'https://registry.example',
  requirements: [],
  tags: {},
};

describe('run history', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-history-'));
    await fs.ensureDir(path.join(bundleDir, 'packages'));
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('writes immutable download run snapshots and resolution changes', async () => {
    await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), beforeManifest, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'dist-tags.json'), distTags, { spaces: 2 });
    await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');
    const before = await captureBundleState(bundleDir);
    const afterManifest: BundleManifest = {
      ...beforeManifest,
      createdAt: '2026-05-25T00:01:00.000Z',
      packages: [
        {
          ...beforeManifest.packages[0]!,
          file: 'packages/demo-1.1.0.tgz',
          tarball: 'https://registry.example/demo/-/demo-1.1.0.tgz',
          version: '1.1.0',
        },
        beforeManifest.packages[1]!,
      ],
    };
    const collectReport: CollectReport = {
      dryRun: false,
      fetch: {
        downloaded: 1,
        downloadedPackages: [
          {
            file: 'packages/demo-1.1.0.tgz',
            name: 'demo',
            raw: 'demo@^1.0.0',
            requiredBy: 'parent@1.0.0',
            resolvedVia: 'range',
            specifier: '^1.0.0',
            type: 'range',
            version: '1.1.0',
          },
        ],
        errors: [],
        generatedAt: '2026-05-25T00:01:00.000Z',
        gitRequirements: [],
        resolved: 2,
        skipped: 1,
        timings: {
          dependencyScanMs: 0,
          downloadMs: 0,
          manifestReadMs: 0,
          resolveMs: 0,
          totalMs: 0,
        },
        unsupported: [],
        wouldDownloadPackages: [],
      },
      fixedPoint: true,
      generatedAt: '2026-05-25T00:01:00.000Z',
      gitFetch: {
        actions: [],
        changed: 0,
        cloned: 0,
        dryRun: false,
        errors: [],
        generatedAt: '2026-05-25T00:01:00.000Z',
        mirrorsDir: path.join(bundleDir, 'git-mirrors'),
        planned: 0,
        totalRepositories: 0,
        unchanged: 0,
        updated: 0,
      },
      gitManifestScanErrors: [],
      gitSources: {
        createdAt: '2026-05-25T00:01:00.000Z',
        schemaVersion: 1,
        skipped: [],
        sources: [],
      },
      iterations: [],
      maxIterationsReached: false,
      outputDir: bundleDir,
      registryUrl: 'https://registry.example',
      repositoryUpdate: {
        detached: 0,
        dirty: 0,
        dryRun: false,
        errors: [],
        generatedAt: '2026-05-25T00:01:00.000Z',
        planned: 0,
        repositories: [],
        root: bundleDir,
        totalRepositories: 0,
        updated: 0,
      },
      root: bundleDir,
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
    };
    const pruneReport: BundlePruneReport = {
      actions: [
        {
          path: 'packages/demo-1.0.0.tgz',
          status: 'removed',
          type: 'npm-package',
        },
      ],
      bundleDir,
      dryRun: false,
      errors: [],
      generatedAt: '2026-05-25T00:01:00.000Z',
      gitMirrors: { kept: 0, removed: 0, stale: 0, total: 0 },
      npmPackages: { kept: 1, removed: 1, stale: 1, total: 2 },
      planned: 1,
      removed: 1,
    };
    await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), afterManifest, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'fetch-report.json'), collectReport.fetch, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'collect-report.json'), collectReport, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'prune-report.json'), pruneReport, { spaces: 2 });

    const historyDir = await writeDownloadRunHistory({
      before,
      bundleDir,
      pruneReport,
      rangeResolutionPolicy: 'reuse-stable',
      report: collectReport,
      tagResolutionPolicy: 'reuse-stable',
    });

    await expect(fs.pathExists(path.join(historyDir, 'seed-manifest.before.json'))).resolves.toBe(
      true
    );
    await expect(fs.pathExists(path.join(historyDir, 'seed-manifest.after.json'))).resolves.toBe(
      true
    );
    await expect(fs.readJson(path.join(historyDir, 'resolution-changes.json'))).resolves.toMatchObject({
      changed: [
        {
          from: '1.0.0',
          name: 'demo',
          reason: 'resolved from source registry',
          requiredBy: 'parent@1.0.0',
          specifier: '^1.0.0',
          to: '1.1.0',
        },
      ],
      removed: [
        {
          path: 'packages/demo-1.0.0.tgz',
        },
      ],
    });
  });
});
