import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { createPublishPlan, isBlockedPublishRegistry, publishBundle } from '../src/index.js';
import { packageNamesMissingLatestTags } from '../src/core/publisher.js';
import type { BundleManifest, DistTagsManifest } from '../src/types.js';

const manifest: BundleManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-20T00:00:00.000Z',
  sourceRegistry: 'https://registry.npmjs.org',
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
  ],
};

const distTags: DistTagsManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-20T00:00:00.000Z',
  sourceRegistry: 'https://registry.npmjs.org',
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

describe('isBlockedPublishRegistry', () => {
  it('blocks known public registries', () => {
    expect(isBlockedPublishRegistry('https://registry.npmjs.org')).toBe(true);
    expect(isBlockedPublishRegistry('https://registry.yarnpkg.com')).toBe(true);
  });

  it('allows private/local registries', () => {
    expect(isBlockedPublishRegistry('http://localhost:4873')).toBe(false);
    expect(isBlockedPublishRegistry('http://192.168.0.10:4873')).toBe(false);
  });
});

describe('createPublishPlan', () => {
  it('plans publish and dist-tag actions', () => {
    expect(createPublishPlan(manifest, distTags)).toEqual([
      {
        action: 'publish',
        package: 'demo@1.0.0',
        status: 'planned',
      },
      {
        action: 'dist-tag',
        package: 'demo@1.0.0',
        status: 'planned',
        tag: 'latest',
      },
    ]);
  });
});

describe('packageNamesMissingLatestTags', () => {
  it('does not require registry existence checks when every package name has latest', () => {
    expect(packageNamesMissingLatestTags(manifest, distTags)).toEqual([]);
  });

  it('returns only package names that are missing latest tags', () => {
    expect(
      packageNamesMissingLatestTags(
        {
          ...manifest,
          packages: [
            ...manifest.packages,
            {
              name: 'untagged',
              version: '1.0.0',
              file: 'packages/untagged-1.0.0.tgz',
              tarball: 'https://registry.example/untagged/-/untagged-1.0.0.tgz',
              resolvedFrom: [],
            },
          ],
        },
        distTags
      )
    ).toEqual(['untagged']);
  });
});

describe('publishBundle', () => {
  it('returns a dry-run report without executing npm commands', async () => {
    const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-publish-'));

    try {
      await fs.ensureDir(path.join(bundleDir, 'packages'));
      await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');

      await expect(
        publishBundle(manifest, distTags, {
          bundleDir,
          dryRun: true,
          registryUrl: 'http://localhost:4873',
        })
      ).resolves.toMatchObject({
        dryRun: true,
        errors: [],
        published: 1,
        registry: 'http://localhost:4873',
        restoredTags: 1,
        skipped: 0,
        totalPackages: 1,
      });
    } finally {
      await fs.remove(bundleDir);
    }
  });

  it('refuses to publish to public registries even in dry-run mode', async () => {
    await expect(
      publishBundle(manifest, distTags, {
        bundleDir: './airgap-bundle',
        dryRun: true,
        registryUrl: 'https://registry.npmjs.org',
      })
    ).rejects.toThrow('Refusing to publish to public registry');
  });
});
