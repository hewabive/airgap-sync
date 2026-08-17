import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tar from 'tar';
import * as fs from '../src/core/fs.js';
import { semanticDigest } from '../src/core/canonical-json.js';
import { defaultNpmSecurityPolicy } from '../src/core/security.js';
import { runGitCommand } from '../src/core/git-fetch.js';
import { TarballInspectionCache, writeTarballInspectionCache } from '../src/core/tarball.js';
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
  downloadedPackages: [],
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
  wouldDownloadPackages: [],
};

const workspaceSnapshot: WorkspaceSnapshot = {
  createdAt: '2026-05-21T00:01:00.000Z',
  output: './bundle',
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
    actions: [],
    changed: 0,
    cloned: 0,
    dryRun: false,
    errors: [],
    generatedAt: '2026-05-21T00:01:00.000Z',
    mirrorsDir: '/bundle/git-mirrors',
    planned: 0,
    totalRepositories: 0,
    unchanged: 0,
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
    actions: [],
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
    migrated: 0,
    migrationFallbacks: [],
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

async function writeTarball(
  filePath: string,
  packageJson: { name: string; scripts?: Record<string, string>; version: string }
): Promise<void> {
  const rootDir = path.join(bundleDir, 'tarball-root');
  const packageDir = path.join(rootDir, 'package');
  await fs.ensureDir(packageDir);
  await fs.writeJson(path.join(packageDir, 'package.json'), packageJson, { spaces: 2 });
  await tar.c(
    {
      cwd: rootDir,
      file: filePath,
      gzip: true,
    },
    ['package']
  );
  await fs.remove(rootDir);
}

async function writeValidBundle(): Promise<void> {
  await fs.ensureDir(path.join(bundleDir, 'packages'));
  await writeTarball(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), {
    name: 'demo',
    version: '1.0.0',
  });
  await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), manifest, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'dist-tags.json'), distTags, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'fetch-report.json'), fetchReport, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'collect-report.json'), collectReport, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'git-sources.json'), gitSources, { spaces: 2 });
  await fs.writeJson(path.join(bundleDir, 'workspace-snapshot.json'), workspaceSnapshot, {
    spaces: 2,
  });
}

async function writePackageManagerGitMirror(): Promise<void> {
  const sourceDir = path.join(bundleDir, 'source');
  const mirrorPath = path.join(bundleDir, 'git-mirrors/github.com/acme/arriero.git');
  await runGitCommand({
    args: ['init', '--initial-branch=main', sourceDir],
  });
  await fs.writeJson(
    path.join(sourceDir, 'package.json'),
    {
      name: 'arriero',
      packageManager: 'pnpm@11.17.0',
      version: '0.1.0',
    },
    { spaces: 2 }
  );
  await fs.writeFile(path.join(sourceDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  await runGitCommand({
    args: ['-C', sourceDir, 'add', 'package.json', 'pnpm-lock.yaml'],
  });
  await runGitCommand({
    args: [
      '-c',
      'user.name=Airgap Sync Test',
      '-c',
      'user.email=airgap-sync@example.invalid',
      '-C',
      sourceDir,
      'commit',
      '-m',
      'Add package manager pin',
    ],
  });
  await fs.ensureDir(path.dirname(mirrorPath));
  await runGitCommand({
    args: ['clone', '--bare', sourceDir, mirrorPath],
  });
  await fs.writeJson(
    path.join(bundleDir, 'git-sources.json'),
    {
      ...gitSources,
      sources: [
        {
          committish: 'main',
          host: 'github.com',
          id: 'github.com/acme/arriero',
          localMirrorPath: 'git-mirrors/github.com/acme/arriero.git',
          owner: 'acme',
          repo: 'arriero',
          requirements: [],
          sourceUrl: 'https://github.com/acme/arriero.git',
          target: true,
        },
      ],
    },
    { spaces: 2 }
  );
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
      allowLegacyBundle: true,
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

    const report = await verifyBundle({ allowLegacyBundle: true, bundleDir });

    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      errors: 0,
      warnings: 0,
    });
  });

  it('treats lifecycle scripts as neutral recorded inventory during verify', async () => {
    await writeValidBundle();
    const tarballPath = path.join(bundleDir, 'packages/demo-1.0.0.tgz');
    await writeTarball(tarballPath, {
      name: 'demo',
      scripts: { postinstall: 'node setup.js' },
      version: '1.0.0',
    });
    const sha256 = createHash('sha256')
      .update(await fs.readFile(tarballPath))
      .digest('hex');
    const secureManifest: BundleManifest = {
      ...manifest,
      packages: [{ ...manifest.packages[0]!, sha256 }],
      schemaVersion: 2,
    };
    await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), secureManifest, { spaces: 2 });
    await fs.writeJson(
      path.join(bundleDir, 'security-report.json'),
      {
        advisories: [],
        errors: [],
        generatedAt: '2026-05-21T00:02:00.000Z',
        manifestSha256: semanticDigest(secureManifest),
        ok: true,
        packageCount: 1,
        policy: defaultNpmSecurityPolicy,
        provider: { name: 'OSV', url: 'https://api.osv.dev/v1/querybatch' },
        schemaVersion: 1,
        staticFindings: [
          {
            allowed: false,
            field: 'scripts.postinstall',
            message: 'demo@1.0.0 declares postinstall lifecycle code',
            name: 'demo',
            severity: 'warning',
            sha256,
            type: 'lifecycle-script',
            value: 'node setup.js',
            version: '1.0.0',
          },
        ],
      },
      { spaces: 2 }
    );
    await fs.writeJson(path.join(bundleDir, 'apply-report.json'), applyReport, { spaces: 2 });

    const report = await verifyBundle({
      bundleDir,
      generatedAt: '2026-05-21T00:03:00.000Z',
    });

    expect(report.ok).toBe(true);
    expect(report.summary.warnings).toBe(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'npm-lifecycle-inventory', status: 'ok' }),
      ])
    );
  });

  it('warns when workspace snapshot is missing', async () => {
    await writeValidBundle();
    await fs.remove(path.join(bundleDir, 'workspace-snapshot.json'));

    const report = await verifyBundle({ allowLegacyBundle: true, bundleDir });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'workspace-snapshot', status: 'warning' }),
      ])
    );
  });

  it('fails fetch errors and missing tarballs', async () => {
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
            requiredBy: 'root',
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
        expect.objectContaining({ name: 'workspace-snapshot', status: 'warning' }),
      ])
    );
  });

  it('fails unreadable tarballs', async () => {
    await writeValidBundle();
    await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), 'not a tarball');

    const report = await verifyBundle({ bundleDir });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tarball-integrity', status: 'error' }),
      ])
    );
  });

  it('ignores the persistent download inspection cache at the verify trust boundary', async () => {
    await writeValidBundle();
    const tarballPath = path.join(bundleDir, 'packages/demo-1.0.0.tgz');
    const sha256 = createHash('sha256')
      .update(await fs.readFile(tarballPath))
      .digest('hex');
    await fs.writeJson(
      path.join(bundleDir, 'seed-manifest.json'),
      {
        ...manifest,
        packages: [{ ...manifest.packages[0]!, sha256 }],
        schemaVersion: 2,
      },
      { spaces: 2 }
    );
    await writeTarballInspectionCache(
      bundleDir,
      new TarballInspectionCache({
        schemaVersion: 1,
        createdAt: '2026-05-21T00:00:00.000Z',
        inspections: {
          [sha256]: {
            manifest: { name: 'wrong-package', version: '9.9.9' },
            manifestSha256: semanticDigest({ name: 'wrong-package', version: '9.9.9' }),
          },
        },
      })
    );

    const report = await verifyBundle({ allowLegacyBundle: true, bundleDir });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'bundle-manifest', status: 'ok' }),
        expect.objectContaining({ name: 'tarball-integrity', status: 'ok' }),
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

  it('fails when a Git target package manager bootstrap is absent from the bundle', async () => {
    await writeValidBundle();
    await writePackageManagerGitMirror();

    const report = await verifyBundle({ bundleDir });

    expect(report.ok).toBe(false);
    const packageManagerCheck = report.checks.find(
      (item) => item.name === 'package-manager-requirements'
    );
    expect(packageManagerCheck).toMatchObject({
      name: 'package-manager-requirements',
      status: 'error',
    });
    const details = packageManagerCheck?.details as
      | { missing: { name: string; specifier: string }[] }
      | undefined;
    expect(
      details?.missing.map((requirement) => `${requirement.name}@${requirement.specifier}`)
    ).toEqual(expect.arrayContaining(['pnpm@11.17.0', '@pnpm/exe@11.17.0']));
  });

  it('verifies Python wheel hashes, identities, and target-environment coverage', async () => {
    await writeValidBundle();
    const wheel = Buffer.from('verified wheel');
    const wheelHash = createHash('sha256').update(wheel).digest('hex');
    const wheelPath = path.join(
      bundleDir,
      'python/artifacts/wheels',
      wheelHash,
      'demo-1.0-py3-none-any.whl'
    );
    await fs.ensureDir(path.dirname(wheelPath));
    await fs.writeFile(wheelPath, wheel);
    await fs.writeJson(
      path.join(bundleDir, 'python-seed-manifest.json'),
      {
        schemaVersion: 1,
        createdAt: '2026-07-10T00:00:00.000Z',
        packages: [
          {
            files: [
              {
                coreMetadata: {
                  metadataVersion: '2.4',
                  name: 'demo',
                  projectUrls: [],
                  providesExtra: [],
                  requiresDist: [],
                  version: '1.0',
                },
                environments: ['linux'],
                file: `python/artifacts/wheels/${wheelHash}/demo-1.0-py3-none-any.whl`,
                filename: 'demo-1.0-py3-none-any.whl',
                kind: 'wheel',
                sha256: wheelHash,
                sourceHashes: { sha256: wheelHash },
                url: 'https://files.example/demo-1.0-py3-none-any.whl',
              },
            ],
            name: 'demo',
            resolvedFrom: [],
            version: '1.0',
          },
        ],
        roots: ['demo==1.0'],
        sourceIndex: 'https://pypi.org/simple/',
        targetEnvironments: [
          {
            arch: 'x86_64',
            manylinux: 'manylinux_2_17',
            name: 'linux',
            os: 'linux',
            pythonVersion: '3.11.9',
          },
        ],
      },
      { spaces: 2 }
    );
    const valid = await verifyBundle({ bundleDir });
    expect(valid.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'python-wheel-files', status: 'ok' }),
        expect.objectContaining({ name: 'python-wheel-integrity', status: 'ok' }),
        expect.objectContaining({ name: 'python-environment-coverage', status: 'ok' }),
      ])
    );

    await fs.writeFile(wheelPath, 'changed');
    const corrupt = await verifyBundle({ bundleDir });
    expect(corrupt.ok).toBe(false);
    expect(corrupt.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'python-wheel-integrity', status: 'error' }),
      ])
    );
  });
});
