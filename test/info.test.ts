import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBundleInfo } from '../src/core/info.js';
import type { BundleManifest, DistTagsManifest, FetchReport, PublishReport } from '../src/types.js';

let bundleDir: string;

const manifest: BundleManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-20T00:00:00.000Z',
  sourceRegistry: 'https://registry.example',
  packages: [
    {
      name: 'demo',
      version: '1.0.0',
      file: 'packages/demo-1.0.0.tgz',
      tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
      resolvedFrom: [
        {
          raw: 'demo@latest',
          requiredBy: 'root',
          specifier: 'latest',
          type: 'tag',
        },
      ],
    },
    {
      name: 'other',
      version: '2.0.0',
      file: 'packages/other-2.0.0.tgz',
      tarball: 'https://registry.example/other/-/other-2.0.0.tgz',
      resolvedFrom: [
        {
          raw: 'other@^2.0.0',
          requiredBy: 'demo@1.0.0',
          specifier: '^2.0.0',
          type: 'range',
        },
      ],
    },
  ],
};

const distTags: DistTagsManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-20T00:00:00.000Z',
  sourceRegistry: 'https://registry.example',
  tags: {
    demo: {
      latest: '1.0.0',
    },
  },
  requirements: [
    {
      name: 'demo',
      version: '1.0.0',
      requiredBy: 'root',
      tag: 'latest',
    },
  ],
};

const fetchReport: FetchReport = {
  downloaded: 2,
  errors: [],
  generatedAt: '2026-05-20T00:01:00.000Z',
  gitRequirements: [],
  resolved: 2,
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

const publishReport: PublishReport = {
  dryRun: false,
  errors: [],
  generatedAt: '2026-05-20T00:02:00.000Z',
  published: 2,
  registry: 'http://localhost:4873',
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
  totalPackages: 2,
};

describe('readBundleInfo', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-info-'));
    await fs.ensureDir(path.join(bundleDir, 'packages'));
    await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), manifest);
    await fs.writeJson(path.join(bundleDir, 'dist-tags.json'), distTags);
    await fs.writeJson(path.join(bundleDir, 'fetch-report.json'), fetchReport);
    await fs.writeJson(path.join(bundleDir, 'publish-report.json'), publishReport);
    await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('summarizes packages, tags, reports, and missing tarballs', async () => {
    await expect(readBundleInfo(bundleDir)).resolves.toMatchObject({
      bundle: bundleDir,
      createdAt: '2026-05-20T00:00:00.000Z',
      fetchReport: {
        exists: true,
        errors: 0,
        generatedAt: '2026-05-20T00:01:00.000Z',
      },
      missingTarballs: ['packages/other-2.0.0.tgz'],
      packageCount: 2,
      packageNameCount: 2,
      packages: [
        {
          file: 'packages/demo-1.0.0.tgz',
          name: 'demo',
          reasons: 1,
          version: '1.0.0',
        },
        {
          file: 'packages/other-2.0.0.tgz',
          name: 'other',
          reasons: 1,
          version: '2.0.0',
        },
      ],
      publishReport: {
        exists: true,
        errors: 0,
        generatedAt: '2026-05-20T00:02:00.000Z',
      },
      sourceRegistry: 'https://registry.example',
      tagCount: 1,
      tags: [
        {
          name: 'demo',
          tag: 'latest',
          version: '1.0.0',
        },
      ],
    });
  });
});
