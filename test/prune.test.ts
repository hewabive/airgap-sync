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
      downloadedPackages: [],
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

  it('removes stale wheels when a Python seed manifest is present', async () => {
    await writeBundleFiles();
    await fs.ensureDir(path.join(bundleDir, 'python-packages'));
    await fs.writeFile(path.join(bundleDir, 'python-packages/kept-1.0-py3-none-any.whl'), 'kept');
    await fs.writeFile(path.join(bundleDir, 'python-packages/stale-1.0-py3-none-any.whl'), 'stale');
    await fs.writeJson(
      path.join(bundleDir, 'python-seed-manifest.json'),
      {
        schemaVersion: 1,
        createdAt: '2026-07-10T00:00:00.000Z',
        packages: [
          {
            files: [
              {
                file: 'python-packages/kept-1.0-py3-none-any.whl',
              },
            ],
            name: 'kept',
            resolvedFrom: [],
            version: '1.0',
          },
        ],
        roots: ['kept==1.0'],
        sourceIndex: 'https://pypi.org/simple/',
        targetEnvironments: [],
      },
      { spaces: 2 }
    );

    const report = await pruneBundle({ bundleDir });

    expect(report.pythonPackages).toEqual({ kept: 1, removed: 1, stale: 1, total: 2 });
    await expect(
      fs.pathExists(path.join(bundleDir, 'python-packages/kept-1.0-py3-none-any.whl'))
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(bundleDir, 'python-packages/stale-1.0-py3-none-any.whl'))
    ).resolves.toBe(false);
  });

  it('keeps artifacts referenced by any active Python application plan', async () => {
    await writeBundleFiles();
    const keptArtifact =
      'python/artifacts/wheels/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/shared.whl';
    const staleArtifact =
      'python/artifacts/wheels/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/stale.whl';
    await fs.ensureDir(path.join(bundleDir, path.dirname(keptArtifact)));
    await fs.ensureDir(path.join(bundleDir, path.dirname(staleArtifact)));
    await fs.writeFile(path.join(bundleDir, keptArtifact), 'kept');
    await fs.writeFile(path.join(bundleDir, staleArtifact), 'stale');
    await fs.ensureDir(path.join(bundleDir, 'python/applications/kept--linux'));
    await fs.ensureDir(path.join(bundleDir, 'python/applications/stale--linux'));
    await fs.writeJson(
      path.join(bundleDir, 'python/application-index.json'),
      {
        applications: [
          {
            application: { name: 'kept', version: '1.0.0' },
            artifactIds: ['a'.repeat(64) + ':shared.whl'],
            branchSizes: [],
            locks: [],
            planDiffPath: 'python/applications/kept--linux/plan-diff.json',
            planId: 'c'.repeat(64),
            planPath: 'python/applications/kept--linux/environment-plan.json',
            prerequisiteReportPath: 'python/applications/kept--linux/prerequisites.json',
            targetId: 'kept--linux',
          },
        ],
        artifacts: [
          {
            file: keptArtifact,
            filename: 'shared.whl',
            id: 'a'.repeat(64) + ':shared.whl',
            kind: 'wheel',
            references: [{ platforms: ['linux-glibc-x86_64'], targetId: 'kept--linux' }],
            sha256: 'a'.repeat(64),
            size: 4,
            sourceUrl: 'https://example.test/shared.whl',
            version: '1.0.0',
          },
        ],
        createdAt: generatedAt,
        schemaVersion: 2,
        summary: { applications: 1, artifacts: 1, totalBytes: 4 },
      },
      { spaces: 2 }
    );

    const report = await pruneBundle({ bundleDir });

    expect(report.pythonApplicationArtifacts).toEqual({
      kept: 1,
      removed: 1,
      stale: 1,
      total: 2,
    });
    expect(report.pythonApplicationPlans).toEqual({
      kept: 1,
      removed: 1,
      stale: 1,
      total: 2,
    });
    expect(report.pythonApplicationArtifactDirectories).toEqual({
      kept: 1,
      removed: 1,
      stale: 1,
      total: 2,
    });
    await expect(fs.pathExists(path.join(bundleDir, keptArtifact))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(bundleDir, staleArtifact))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(bundleDir, path.dirname(staleArtifact)))).resolves.toBe(
      false
    );
    await expect(
      fs.pathExists(path.join(bundleDir, 'python/applications/kept--linux'))
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(bundleDir, 'python/applications/stale--linux'))
    ).resolves.toBe(false);
  });

  it('removes orphaned Python application objects even when the application index is absent', async () => {
    await writeBundleFiles();
    const orphanedArtifact =
      'python/artifacts/wheels/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/orphaned.whl';
    const orphanedArtifactDirectory = path.dirname(orphanedArtifact);
    const orphanedPlan = 'python/applications/orphaned--linux';
    await fs.ensureDir(path.join(bundleDir, orphanedArtifactDirectory));
    await fs.writeFile(path.join(bundleDir, orphanedArtifact), 'orphaned');
    await fs.ensureDir(path.join(bundleDir, orphanedPlan));
    await fs.writeFile(path.join(bundleDir, orphanedPlan, 'environment-plan.json'), '{}');

    const dryRun = await pruneBundle({ bundleDir, dryRun: true });

    expect(dryRun.pythonApplicationArtifacts).toEqual({
      kept: 0,
      removed: 0,
      stale: 1,
      total: 1,
    });
    expect(dryRun.pythonApplicationArtifactDirectories).toEqual({
      kept: 0,
      removed: 0,
      stale: 1,
      total: 1,
    });
    expect(dryRun.pythonApplicationPlans).toEqual({
      kept: 0,
      removed: 0,
      stale: 1,
      total: 1,
    });
    expect(dryRun.actions.filter((action) => action.type.startsWith('python-application'))).toEqual(
      [
        expect.objectContaining({
          path: orphanedArtifact,
          status: 'planned',
          type: 'python-application-artifact',
        }),
        expect.objectContaining({
          path: orphanedArtifactDirectory,
          status: 'planned',
          type: 'python-application-artifact-directory',
        }),
        expect.objectContaining({
          path: orphanedPlan,
          status: 'planned',
          type: 'python-application-plan',
        }),
      ]
    );
    await expect(fs.pathExists(path.join(bundleDir, orphanedArtifact))).resolves.toBe(true);

    const report = await pruneBundle({ bundleDir });

    expect(report.pythonApplicationArtifacts?.removed).toBe(1);
    expect(report.pythonApplicationArtifactDirectories?.removed).toBe(1);
    expect(report.pythonApplicationPlans?.removed).toBe(1);
    await expect(fs.pathExists(path.join(bundleDir, orphanedArtifact))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(bundleDir, orphanedArtifactDirectory))).resolves.toBe(
      false
    );
    await expect(fs.pathExists(path.join(bundleDir, orphanedPlan))).resolves.toBe(false);
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
