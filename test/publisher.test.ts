import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublishPlan, isBlockedPublishRegistry, publishBundle } from '../src/index.js';
import type { NpmRunner, PublishProgressEvent } from '../src/core/publisher.js';
import type { BundleManifest, DistTagsManifest } from '../src/types.js';

const fetchMock = vi.fn<typeof fetch>();

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
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('plans computed bundled latest actions without persisted dist-tags', () => {
    expect(
      createPublishPlan(
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
    ).toEqual([
      {
        action: 'publish',
        package: 'demo@1.0.0',
        status: 'planned',
      },
      {
        action: 'publish',
        package: 'untagged@1.0.0',
        status: 'planned',
      },
      {
        action: 'dist-tag',
        package: 'demo@1.0.0',
        status: 'planned',
        tag: 'latest',
      },
      {
        action: 'dist-tag',
        package: 'untagged@1.0.0',
        status: 'planned',
        tag: 'latest',
      },
    ]);
  });
});

describe('publishBundle', () => {
  it('returns a dry-run report without executing npm commands', async () => {
    const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-publish-'));
    const progress: PublishProgressEvent[] = [];

    try {
      await fs.ensureDir(path.join(bundleDir, 'packages'));
      await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');

      const report = await publishBundle(manifest, distTags, {
        bundleDir,
        dryRun: true,
        onProgress(event) {
          progress.push(event);
        },
        registryUrl: 'http://localhost:4873',
      });

      expect(report).toMatchObject({
        dryRun: true,
        errors: [],
        published: 1,
        registry: 'http://localhost:4873',
        restoredTags: 1,
        skipped: 0,
        timings: {
          cleanupMs: 0,
          distTagsMs: 0,
          lookupMetadataMs: 0,
          publishMs: 0,
        },
        totalPackages: 1,
      });
      expect(report.timings.dryRunMs).toBeGreaterThanOrEqual(0);
      expect(report.timings.totalMs).toBeGreaterThanOrEqual(0);
      expect(report.timings.validateMs).toBeGreaterThanOrEqual(0);
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

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
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
        }),
        { status: 200 }
      )
    );

    try {
      await fs.ensureDir(path.join(bundleDir, 'packages'));
      await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');

      const report = await publishBundle(manifest, distTags, {
        bundleDir,
        onProgress(event) {
          progress.push(event);
        },
        registryUrl: 'http://localhost:4873',
      });

      expect(report).toMatchObject({
        dryRun: false,
        errors: [],
        published: 0,
        restoredTags: 1,
        skipped: 1,
        timings: {
          dryRunMs: 0,
        },
        totalPackages: 1,
      });
      expect(report.timings.cleanupMs).toBeGreaterThanOrEqual(0);
      expect(report.timings.distTagsMs).toBeGreaterThanOrEqual(0);
      expect(report.timings.lookupMetadataMs).toBeGreaterThanOrEqual(0);
      expect(report.timings.publishMs).toBeGreaterThanOrEqual(0);
      expect(report.timings.totalMs).toBeGreaterThanOrEqual(0);
      expect(report.timings.validateMs).toBeGreaterThanOrEqual(0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall?.[0]).toBe('http://localhost:4873/demo');
      expect(firstCall?.[1]).toMatchObject({
        headers: {
          Accept: 'application/vnd.npm.install-v1+json, application/json',
        },
      });
      expect(firstCall?.[1]?.signal).toBeDefined();
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

  it('does not downgrade a newer registry latest for bundled latest requirements', async () => {
    const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-publish-'));
    const progress: PublishProgressEvent[] = [];

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          'dist-tags': {
            latest: '2.0.0',
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
            '2.0.0': {
              dist: {
                tarball: 'https://registry.example/demo/-/demo-2.0.0.tgz',
              },
              name: 'demo',
              version: '2.0.0',
            },
          },
        }),
        { status: 200 }
      )
    );

    try {
      await fs.ensureDir(path.join(bundleDir, 'packages'));
      await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');

      const report = await publishBundle(
        manifest,
        {
          ...distTags,
          requirements: [],
          tags: {},
        },
        {
          bundleDir,
          onProgress(event) {
            progress.push(event);
          },
          registryUrl: 'http://localhost:4873',
        }
      );

      expect(report).toMatchObject({
        errors: [],
        published: 0,
        restoredTags: 1,
        skipped: 1,
      });
      expect(progress).toContainEqual({
        current: 1,
        package: 'demo@1.0.0',
        phase: 'dist-tags',
        status: 'skipped',
        tag: 'latest',
        total: 1,
      });
    } finally {
      await fs.remove(bundleDir);
    }
  });

  it('treats a failed publish as skipped when the version appears in the registry afterwards', async () => {
    const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-publish-'));
    const npmCalls: string[][] = [];
    const runNpm: NpmRunner = (args) => {
      npmCalls.push(args);
      if (args[0] === 'publish') {
        const error = new Error('Command failed: npm publish') as Error & {
          stderr?: string;
        };
        error.stderr = '';
        return Promise.reject(error);
      }
      return Promise.resolve({ stdout: '' });
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            'dist-tags': {},
            name: 'demo',
            versions: {},
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
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
          }),
          { status: 200 }
        )
      );

    try {
      await fs.ensureDir(path.join(bundleDir, 'packages'));
      await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');

      const report = await publishBundle(manifest, distTags, {
        bundleDir,
        registryUrl: 'http://localhost:4873',
        runNpm,
      });

      expect(report).toMatchObject({
        errors: [],
        published: 0,
        skipped: 1,
      });
      const publishTarballPath = npmCalls[0]?.[1];
      expect(path.basename(publishTarballPath ?? '')).toBe('demo-1.0.0.tgz');
      expect(path.dirname(publishTarballPath ?? '')).not.toBe(path.join(bundleDir, 'packages'));
      expect(npmCalls).toEqual([
        [
          'publish',
          publishTarballPath,
          '--registry',
          'http://localhost:4873',
          '--tag',
          'airgap-sync-temp',
          '--provenance',
          'false',
          '--json',
        ],
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await fs.remove(bundleDir);
    }
  });

  it('summarizes npm publish json errors', async () => {
    const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-publish-'));
    const runNpm: NpmRunner = (args) => {
      if (args[0] === 'publish') {
        const error = new Error('Command failed: npm publish') as Error & {
          stderr?: string;
        };
        error.stderr = [
          'npm error You cannot publish over the previously published versions: 1.0.0.',
          '{',
          '  "error": {',
          '    "summary": "You cannot publish over the previously published versions: 1.0.0.",',
          '    "detail": ""',
          '  }',
          '}',
        ].join('\n');
        return Promise.reject(error);
      }

      return Promise.resolve({ stdout: '' });
    };

    try {
      await fs.ensureDir(path.join(bundleDir, 'packages'));
      await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');

      const report = await publishBundle(manifest, distTags, {
        bundleDir,
        registryUrl: 'http://localhost:4873',
        runNpm,
        skipExisting: false,
      });

      expect(report.errors).toContainEqual({
        action: 'publish',
        error: 'You cannot publish over the previously published versions: 1.0.0.',
        package: 'demo@1.0.0',
        status: 'error',
      });
    } finally {
      await fs.remove(bundleDir);
    }
  });
});
