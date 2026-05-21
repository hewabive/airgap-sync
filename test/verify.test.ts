import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import { verifyBundle } from '../src/core/verify.js';
import type {
  ApplyBundleReport,
  BundleManifest,
  CollectReport,
  DistTagsManifest,
  FetchReport,
  GitSourcesManifest,
} from '../src/types.js';
import type { WorkspaceSnapshot } from '../src/core/workspace.js';

let bundleDir: string;

const manifest: BundleManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-21T00:00:00.000Z',
  packages: [
    {
      file: 'packages/demo-1.0.0.tgz',
      name: 'demo',
      resolvedFrom: [
        {
          raw: 'demo@latest',
          requiredBy: 'root',
          specifier: 'latest',
          type: 'tag',
        },
      ],
      tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
      version: '1.0.0',
    },
  ],
  sourceRegistry: 'https://registry.example',
};

const distTags: DistTagsManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-21T00:00:00.000Z',
  requirements: [
    {
      name: 'demo',
      requiredBy: 'root',
      tag: 'latest',
      version: '1.0.0',
    },
  ],
  sourceRegistry: 'https://registry.example',
  tags: {
    demo: {
      latest: '1.0.0',
    },
  },
};

const fetchReport: FetchReport = {
  downloaded: 1,
  errors: [],
  generatedAt: '2026-05-21T00:01:00.000Z',
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
};

const workspaceSnapshot: WorkspaceSnapshot = {
  createdAt: '2026-05-21T00:01:00.000Z',
  output: './bundle',
  reposDir: './repos',
  schemaVersion: 1,
  sourceRegistry: 'https://registry.example',
  targets: [
    {
      spec: 'demo@latest',
      type: 'npm',
    },
  ],
};

const gitSources: GitSourcesManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-21T00:01:00.000Z',
  skipped: [],
  sources: [],
};

const collectReport: CollectReport = {
  dryRun: false,
  fetch: fetchReport,
  fixedPoint: true,
  generatedAt: '2026-05-21T00:01:00.000Z',
  gitFetch: {
    cloned: 0,
    dryRun: false,
    errors: [],
    generatedAt: '2026-05-21T00:01:00.000Z',
    mirrorsDir: '/bundle/git-mirrors',
    planned: 0,
    totalRepositories: 0,
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
    generatedAt: '2026-05-21T00:01:00.000Z',
    planned: 0,
    repositories: [],
    root: '/repos',
    totalRepositories: 0,
    updated: 0,
  },
  root: '/repos',
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

const applyReport: ApplyBundleReport = {
  dryRun: false,
  generatedAt: '2026-05-21T00:02:00.000Z',
  gitApply: {
    dryRun: false,
    errors: [],
    generatedAt: '2026-05-21T00:02:00.000Z',
    gitConfigRewriteRules: [],
    mirrorsDir: '/bundle/git-mirrors',
    missingMirrors: 0,
    planned: 0,
    pushed: 0,
    totalRepositories: 0,
  },
  gitea: {
    created: 0,
    dryRun: false,
    errors: [],
    exists: 0,
    generatedAt: '2026-05-21T00:02:00.000Z',
    giteaBaseUrl: 'http://gitea.local',
    organizationCreated: 0,
    organizationErrors: [],
    organizationExists: 0,
    organizationPlanned: 0,
    organizations: [],
    planned: 0,
    private: true,
    totalOrganizations: 0,
    totalRepositories: 0,
  },
  publish: {
    dryRun: false,
    errors: [],
    generatedAt: '2026-05-21T00:02:00.000Z',
    published: 1,
    registry: 'http://verdaccio.local:4873',
    restoredTags: 1,
    skipped: 0,
    timings: {
      cleanupMs: 0,
      distTagsMs: 0,
      dryRunMs: 0,
      lookupMetadataMs: 0,
      publishMs: 0,
      totalMs: 0,
      validateMs: 0,
    },
    totalPackages: 1,
  },
  registryUrl: 'http://verdaccio.local:4873',
  succeeded: true,
};

async function writeValidBundle(): Promise<void> {
  await fs.ensureDir(path.join(bundleDir, 'packages'));
  await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');
  await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), manifest, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'dist-tags.json'), distTags, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'fetch-report.json'), fetchReport, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'collect-report.json'), collectReport, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'git-sources.json'), gitSources, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'workspace-snapshot.json'), workspaceSnapshot, {
    spaces: 2,
  });
}

describe('verifyBundle', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-verify-'));
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('passes a complete collected bundle and warns before apply', async () => {
    await writeValidBundle();

    const report = await verifyBundle({
      bundleDir,
      generatedAt: '2026-05-21T00:03:00.000Z',
    });

    expect(report).toMatchObject({
      generatedAt: '2026-05-21T00:03:00.000Z',
      ok: true,
      summary: {
        errors: 0,
        warnings: 1,
      },
    });
    expect(report.checks.map((item) => `${item.status}:${item.name}`)).toContain(
      'warning:apply-report'
    );
    expect(await fs.pathExists(path.join(bundleDir, 'verify-report.json'))).toBe(true);
  });

  it('passes without warnings after successful apply', async () => {
    await writeValidBundle();
    await fs.writeJson(path.join(bundleDir, 'apply-report.json'), applyReport, { spaces: 2 });

    const report = await verifyBundle({ bundleDir });

    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      errors: 0,
      warnings: 0,
    });
  });

  it('fails missing workspace snapshot, fetch errors, and missing tarballs', async () => {
    await writeValidBundle();
    await fs.remove(path.join(bundleDir, 'workspace-snapshot.json'));
    await fs.remove(path.join(bundleDir, 'packages/demo-1.0.0.tgz'));
    await fs.writeJson(
      path.join(bundleDir, 'fetch-report.json'),
      {
        ...fetchReport,
        errors: [
          {
            name: 'demo',
            raw: 'demo@latest',
            reason: 'not found',
            specifier: 'latest',
            type: 'tag',
          },
        ],
      },
      { spaces: 2 }
    );

    const report = await verifyBundle({ bundleDir });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tarballs', status: 'error' }),
        expect.objectContaining({ name: 'fetch-report', status: 'error' }),
        expect.objectContaining({ name: 'workspace-snapshot', status: 'error' }),
      ])
    );
  });

  it('fails when Git mirrors are missing', async () => {
    await writeValidBundle();
    await fs.writeJson(
      path.join(bundleDir, 'git-sources.json'),
      {
        ...gitSources,
        sources: [
          {
            host: 'github.com',
            id: 'github.com/acme/app',
            localMirrorPath: 'git-mirrors/github.com/acme/app.git',
            owner: 'acme',
            repo: 'app',
            requirements: [],
            sourceUrl: 'https://github.com/acme/app.git',
          },
        ],
      },
      { spaces: 2 }
    );

    const report = await verifyBundle({ bundleDir });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'git-mirrors', status: 'error' })])
    );
  });
});
