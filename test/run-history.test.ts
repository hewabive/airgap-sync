import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureBundleState,
  createNpmSecurityDeltaReport,
  defaultNpmSecurityPolicy,
  evaluateDownloadWindowGap,
  readLastSuccessfulFullDownload,
  writeDownloadRunHistory,
} from '../src/index.js';
import type {
  BundleManifest,
  BundlePruneReport,
  CollectReport,
  DistTagsManifest,
  NpmSecurityReport,
} from '../src/types.js';

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

function npmSecurityReport(generatedAt: string, advisoryId: string): NpmSecurityReport {
  return {
    advisories: [
      {
        aliases: [],
        id: advisoryId,
        name: 'demo',
        severity: 'warning',
        type: 'vulnerability',
        version: '1.0.0',
      },
    ],
    errors: [],
    generatedAt,
    manifestSha256: 'manifest',
    ok: true,
    packageCount: 2,
    policy: defaultNpmSecurityPolicy,
    provider: { name: 'OSV', url: 'https://api.osv.dev/v1/querybatch' },
    schemaVersion: 1,
    staticFindings: [],
  };
}

function collectReport(bundleDir: string, generatedAt: string): CollectReport {
  return {
    dryRun: false,
    fetch: {
      downloaded: 0,
      downloadedPackages: [],
      errors: [],
      generatedAt,
      gitRequirements: [],
      resolved: 2,
      skipped: 2,
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
    generatedAt,
    gitFetch: {
      actions: [],
      changed: 0,
      cloned: 0,
      dryRun: false,
      errors: [],
      generatedAt,
      mirrorsDir: path.join(bundleDir, 'git-mirrors'),
      planned: 0,
      totalRepositories: 0,
      unchanged: 0,
      updated: 0,
    },
    gitManifestScanErrors: [],
    gitSources: {
      createdAt: generatedAt,
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
      generatedAt,
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
}

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
    const beforeSecurity = npmSecurityReport('2026-05-25T00:00:00.000Z', 'GHSA-before');
    await fs.writeJson(path.join(bundleDir, 'security-report.json'), beforeSecurity, { spaces: 2 });
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
    const report = collectReport(bundleDir, '2026-05-25T00:01:00.000Z');
    report.security = npmSecurityReport('2026-05-25T00:01:00.000Z', 'GHSA-after');
    const securityDeltas = {
      npm: createNpmSecurityDeltaReport(report.security, before.npmSecurityReport),
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
      pythonPackages: { kept: 0, removed: 0, stale: 0, total: 0 },
      planned: 1,
      removed: 1,
    };
    await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), afterManifest, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'fetch-report.json'), report.fetch, {
      spaces: 2,
    });
    await fs.writeJson(path.join(bundleDir, 'collect-report.json'), report, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'prune-report.json'), pruneReport, { spaces: 2 });

    const historyDir = await writeDownloadRunHistory({
      before,
      bundleDir,
      completedAt: '2026-05-25T00:01:30.000Z',
      pruneReport,
      rangeResolutionPolicy: 'reuse-stable',
      report,
      securityDeltas,
      tagResolutionPolicy: 'reuse-stable',
    });

    await expect(fs.pathExists(path.join(historyDir, 'seed-manifest.before.json'))).resolves.toBe(
      true
    );
    await expect(fs.readJson(path.join(historyDir, 'run.json'))).resolves.toEqual({
      completedAt: '2026-05-25T00:01:30.000Z',
      schemaVersion: 1,
      scope: 'full',
      startedAt: '2026-05-25T00:01:00.000Z',
      status: 'success',
    });
    await expect(fs.pathExists(path.join(historyDir, 'seed-manifest.after.json'))).resolves.toBe(
      true
    );
    await expect(
      fs.readJson(path.join(historyDir, 'security-report.before.json'))
    ).resolves.toMatchObject({ generatedAt: '2026-05-25T00:00:00.000Z' });
    await expect(
      fs.readJson(path.join(historyDir, 'security-report.after.json'))
    ).resolves.toMatchObject({ generatedAt: '2026-05-25T00:01:00.000Z' });
    await expect(fs.readJson(path.join(historyDir, 'security-delta.json'))).resolves.toMatchObject({
      comparison: { status: 'compared' },
      summary: { added: 1, removed: 1 },
    });
    await expect(
      fs.readJson(path.join(historyDir, 'resolution-changes.json'))
    ).resolves.toMatchObject({
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
    await expect(fs.readJson(path.join(historyDir, 'package-changes.json'))).resolves.toMatchObject(
      {
        added: [
          {
            file: 'packages/demo-1.1.0.tgz',
            id: 'demo@1.1.0',
            name: 'demo',
            version: '1.1.0',
          },
        ],
        removed: [
          {
            file: 'packages/demo-1.0.0.tgz',
            id: 'demo@1.0.0',
            name: 'demo',
            version: '1.0.0',
          },
        ],
        summary: {
          added: 1,
          after: 2,
          before: 2,
          removed: 1,
        },
      }
    );
  });

  it('does not copy a stale prune report when the current run did not prune', async () => {
    await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), beforeManifest, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'dist-tags.json'), distTags, { spaces: 2 });
    const before = await captureBundleState(bundleDir);
    const report = collectReport(bundleDir, '2026-05-25T00:02:00.000Z');
    await fs.writeJson(path.join(bundleDir, 'fetch-report.json'), report.fetch, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'collect-report.json'), report, { spaces: 2 });
    await fs.writeJson(
      path.join(bundleDir, 'prune-report.json'),
      {
        actions: [{ path: 'packages/stale.tgz', status: 'removed', type: 'npm-package' }],
      },
      { spaces: 2 }
    );

    const historyDir = await writeDownloadRunHistory({
      before,
      bundleDir,
      rangeResolutionPolicy: 'reuse-stable',
      report,
      tagResolutionPolicy: 'reuse-stable',
    });

    await expect(fs.pathExists(path.join(historyDir, 'prune-report.json'))).resolves.toBe(false);
  });

  it('does not advance the security baseline after an unsuccessful download', async () => {
    const activeBefore = npmSecurityReport('2026-05-25T00:00:00.000Z', 'GHSA-before-failed-run');
    await fs.writeJson(path.join(bundleDir, 'security-report.json'), activeBefore, { spaces: 2 });
    const before = await captureBundleState(bundleDir);
    const current = npmSecurityReport('2026-05-25T00:04:00.000Z', 'GHSA-from-failed-run');
    await fs.writeJson(path.join(bundleDir, 'security-report.json'), current, { spaces: 2 });
    const report = collectReport(bundleDir, '2026-05-25T00:04:00.000Z');
    report.security = current;
    report.wroteBundle = false;

    await writeDownloadRunHistory({
      before,
      bundleDir,
      rangeResolutionPolicy: 'reuse-stable',
      report,
      securityDeltas: {
        npm: createNpmSecurityDeltaReport(current, before.npmSecurityReport),
      },
      tagResolutionPolicy: 'reuse-stable',
    });

    const next = await captureBundleState(bundleDir);
    expect(next.npmSecurityReport?.generatedAt).toBe('2026-05-25T00:00:00.000Z');
    expect(next.npmSecurityReport?.advisories[0]?.id).toBe('GHSA-before-failed-run');
  });

  it('allows download history to start from an obsolete Python application bundle', async () => {
    await fs.writeJson(
      path.join(bundleDir, 'python/application-index.json'),
      {
        applications: [],
        artifacts: [],
        createdAt: '2026-05-25T00:00:00.000Z',
        schemaVersion: 1,
        summary: { applications: 0, artifacts: 0, totalBytes: 0 },
      },
      { spaces: 2 }
    );

    const before = await captureBundleState(bundleDir);

    expect(before.pythonApplicationIndex).toBeUndefined();
    expect(before.pythonApplicationDocuments).toEqual([]);

    const historyDir = await writeDownloadRunHistory({
      before,
      bundleDir,
      rangeResolutionPolicy: 'reuse-stable',
      report: collectReport(bundleDir, '2026-05-25T00:03:00.000Z'),
      tagResolutionPolicy: 'reuse-stable',
    });

    await expect(
      fs.readJson(path.join(historyDir, 'python-application-index.after.json'))
    ).resolves.toMatchObject({ schemaVersion: 1 });
  });

  it('finds the latest successful full download and ignores newer partial and failed runs', async () => {
    const before = await captureBundleState(bundleDir);
    await writeDownloadRunHistory({
      before,
      bundleDir,
      completedAt: '2026-05-25T00:01:30.000Z',
      rangeResolutionPolicy: 'reuse-stable',
      report: collectReport(bundleDir, '2026-05-25T00:01:00.000Z'),
      tagResolutionPolicy: 'reuse-stable',
    });
    await writeDownloadRunHistory({
      before,
      bundleDir,
      completedAt: '2026-05-25T00:02:30.000Z',
      rangeResolutionPolicy: 'reuse-stable',
      report: collectReport(bundleDir, '2026-05-25T00:02:00.000Z'),
      scope: 'partial',
      selectedTargetIndexes: [3, 1, 3],
      tagResolutionPolicy: 'reuse-stable',
    });
    const failed = collectReport(bundleDir, '2026-05-25T00:03:00.000Z');
    failed.fetch.errors.push({
      name: 'demo',
      raw: 'demo@latest',
      reason: 'offline',
      requiredBy: 'root',
      specifier: 'latest',
      type: 'tag',
    });
    await writeDownloadRunHistory({
      before,
      bundleDir,
      completedAt: '2026-05-25T00:03:30.000Z',
      rangeResolutionPolicy: 'reuse-stable',
      report: failed,
      tagResolutionPolicy: 'reuse-stable',
    });

    await expect(readLastSuccessfulFullDownload(bundleDir)).resolves.toEqual({
      completedAt: '2026-05-25T00:01:30.000Z',
      schemaVersion: 1,
      scope: 'full',
      startedAt: '2026-05-25T00:01:00.000Z',
      status: 'success',
    });
  });

  it('evaluates fixed-duration download windows', () => {
    const record = {
      completedAt: '2026-05-01T12:00:00.000Z',
      schemaVersion: 1 as const,
      scope: 'full' as const,
      startedAt: '2026-05-01T11:00:00.000Z',
      status: 'success' as const,
    };

    expect(
      evaluateDownloadWindowGap(record, 30, new Date('2026-05-31T12:00:00.000Z'))
    ).toMatchObject({
      elapsedDays: 30,
      exceedsWindow: false,
      requiredWindowDays: 30,
    });
    expect(
      evaluateDownloadWindowGap(record, 30, new Date('2026-05-31T12:00:00.001Z'))
    ).toMatchObject({
      exceedsWindow: true,
      requiredWindowDays: 31,
    });
  });
});
