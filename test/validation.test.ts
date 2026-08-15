import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throwIfInvalidBundle, validateBundle } from '../src/core/validation.js';
import type { BundleManifest, DistTagsManifest } from '../src/types.js';

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

describe('validateBundle', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-validation-'));
    await fs.ensureDir(path.join(bundleDir, 'packages'));
    await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(bundleDir);
  });

  it('accepts a consistent bundle', async () => {
    await expect(validateBundle(bundleDir, manifest, distTags)).resolves.toEqual({
      issues: [],
      valid: true,
    });
  });

  it('reports missing tarballs and tag targets outside the manifest', async () => {
    const brokenDistTags: DistTagsManifest = {
      ...distTags,
      tags: {
        demo: {
          latest: '2.0.0',
        },
      },
      requirements: [
        {
          name: 'demo',
          version: '2.0.0',
          requiredBy: 'root',
          tag: 'latest',
        },
      ],
    };
    await fs.remove(path.join(bundleDir, 'packages/demo-1.0.0.tgz'));

    await expect(validateBundle(bundleDir, manifest, brokenDistTags)).resolves.toMatchObject({
      issues: [
        {
          code: 'tag-target-missing-package',
        },
        {
          code: 'missing-tarball',
        },
      ],
      valid: false,
    });
  });

  it('validates tarballs with bounded concurrency and reports progress', async () => {
    const packages = Array.from({ length: 6 }, (_, index) => ({
      ...manifest.packages[0]!,
      file: `packages/demo-${String(index)}.tgz`,
      version: `1.0.${String(index)}`,
    }));
    await Promise.all(
      packages.map(async (pkg) => fs.writeFile(path.join(bundleDir, pkg.file), ''))
    );

    const originalPathExists = fs.pathExists;
    let active = 0;
    let maxActive = 0;
    vi.spyOn(fs, 'pathExists').mockImplementation(async (filePath) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const exists = await originalPathExists(filePath);
      active--;
      return exists;
    });
    const progress: { current: number; package: string; total: number }[] = [];

    const result = await validateBundle(bundleDir, { ...manifest, packages }, distTags, {
      concurrency: 3,
      onProgress(event) {
        progress.push(event);
      },
    });

    expect(result).toEqual({ issues: [], valid: true });
    expect(maxActive).toBe(3);
    expect(progress).toHaveLength(packages.length);
    expect(progress.map((event) => event.current)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress.every((event) => event.total === packages.length)).toBe(true);
  });

  it('throws a readable error for invalid bundles', () => {
    expect(() => {
      throwIfInvalidBundle({
        valid: false,
        issues: [
          {
            code: 'missing-tarball',
            message: 'demo@1.0.0 tarball is missing',
            severity: 'error',
          },
        ],
      });
    }).toThrow('Invalid airgap bundle');
  });
});
