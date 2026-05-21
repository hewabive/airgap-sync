import os from 'node:os';
import path from 'node:path';
import type { AxiosRequestConfig } from 'axios';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublishPlan, isBlockedPublishRegistry, publishBundle } from '../src/index.js';
import { packageNamesMissingLatestTags } from '../src/core/publisher.js';
import type { PublishProgressEvent } from '../src/core/publisher.js';
import type { BundleManifest, DistTagsManifest } from '../src/types.js';

type AxiosGet = (
  url: string,
  config?: AxiosRequestConfig
) => Promise<{ data: unknown; status: number }>;

const axiosMock = vi.hoisted(() => ({
  get: vi.fn<AxiosGet>(),
}));

vi.mock('axios', () => ({
  default: axiosMock,
}));

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

beforeEach(() => {
  axiosMock.get.mockReset();
});

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
    const progress: PublishProgressEvent[] = [];

    try {
      await fs.ensureDir(path.join(bundleDir, 'packages'));
      await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');

      await expect(
        publishBundle(manifest, distTags, {
          bundleDir,
          dryRun: true,
          onProgress(event) {
            progress.push(event);
          },
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
      expect(progress).toEqual([
        {
          phase: 'validate',
          status: 'start',
        },
        {
          phase: 'validate',
          status: 'done',
        },
        {
          current: 2,
          phase: 'dry-run',
          status: 'planned',
          total: 2,
        },
      ]);
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

  it('uses package metadata to skip existing versions and tags', async () => {
    const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-publish-'));
    const progress: PublishProgressEvent[] = [];

    axiosMock.get.mockResolvedValue({
      data: {
        'dist-tags': {
          latest: '1.0.0',
        },
        name: 'demo',
        versions: {
          '1.0.0': {
            dist: {
              tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
            },
            name: 'demo',
            version: '1.0.0',
          },
        },
      },
      status: 200,
    });

    try {
      await fs.ensureDir(path.join(bundleDir, 'packages'));
      await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');

      await expect(
        publishBundle(manifest, distTags, {
          bundleDir,
          onProgress(event) {
            progress.push(event);
          },
          registryUrl: 'http://localhost:4873',
        })
      ).resolves.toMatchObject({
        dryRun: false,
        errors: [],
        published: 0,
        restoredTags: 1,
        skipped: 1,
        totalPackages: 1,
      });

      expect(axiosMock.get).toHaveBeenCalledTimes(1);
      const firstCall = axiosMock.get.mock.calls[0];
      expect(firstCall?.[0]).toBe('http://localhost:4873/demo');
      expect(firstCall?.[1]).toMatchObject({
        headers: {
          Accept: 'application/vnd.npm.install-v1+json, application/json',
        },
        timeout: 30_000,
      });
      expect(firstCall?.[1]?.httpAgent).toBeDefined();
      expect(firstCall?.[1]?.httpsAgent).toBeDefined();
      expect(firstCall?.[1]?.validateStatus).toBeTypeOf('function');
      expect(progress).toContainEqual({
        current: 1,
        phase: 'lookup-metadata',
        status: 'done',
        total: 1,
      });
    } finally {
      await fs.remove(bundleDir);
    }
  });
});
