import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
