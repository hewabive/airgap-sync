import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import {
  readStableTagResolutionIndex,
  stableRangeRequirement,
  stableTagRequirement,
} from '../src/core/tag-resolution.js';
import type { BundleManifest, DistTagsManifest } from '../src/types.js';

describe('readStableTagResolutionIndex', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-tag-resolution-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('indexes only package files present in one bundle directory listing', async () => {
    const manifest: BundleManifest = {
      schemaVersion: 2,
      createdAt: '2026-08-09T00:00:00.000Z',
      sourceRegistry: 'https://registry.example',
      packages: [
        {
          name: 'demo',
          version: '1.0.0',
          file: 'packages/demo-1.0.0.tgz',
          publishedAt: '2020-01-01T00:00:00.000Z',
          resolvedFrom: [
            {
              raw: 'demo@^1.0.0',
              requiredBy: 'app@1.0.0',
              specifier: '^1.0.0',
              type: 'range',
            },
          ],
          sha256: 'a'.repeat(64),
          tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
        },
        {
          name: 'missing',
          version: '2.0.0',
          file: 'packages/missing-2.0.0.tgz',
          publishedAt: '2020-01-02T00:00:00.000Z',
          resolvedFrom: [],
          sha256: 'b'.repeat(64),
          tarball: 'https://registry.example/missing/-/missing-2.0.0.tgz',
        },
      ],
    };
    const distTags: DistTagsManifest = {
      schemaVersion: 1,
      createdAt: '2026-08-09T00:00:00.000Z',
      sourceRegistry: 'https://registry.example',
      requirements: [
        {
          name: 'demo',
          requiredBy: 'root',
          tag: 'latest',
          version: '1.0.0',
        },
      ],
      tags: { demo: { latest: '1.0.0' } },
    };

    await fs.ensureDir(path.join(tempDir, 'packages'));
    await Promise.all([
      fs.writeFile(path.join(tempDir, 'packages', 'demo-1.0.0.tgz'), ''),
      fs.writeJson(path.join(tempDir, 'seed-manifest.json'), manifest),
      fs.writeJson(path.join(tempDir, 'dist-tags.json'), distTags),
    ]);

    const index = await readStableTagResolutionIndex(tempDir);

    expect([...index.packageIds]).toEqual(['demo@1.0.0']);
    expect(index.packagePublishedAt).toEqual(new Map([['demo@1.0.0', '2020-01-01T00:00:00.000Z']]));
    expect(
      stableRangeRequirement({ name: 'demo', requiredBy: 'app@1.0.0', specifier: '^1.0.0' }, index)
    ).toMatchObject({ version: '1.0.0' });
    expect(
      stableTagRequirement({ name: 'demo', requiredBy: 'root', specifier: 'latest' }, index)
    ).toMatchObject({ version: '1.0.0' });
  });
});
