import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from '../src/core/fs.js';
import { createBundleDocuments, writeBundleDocuments } from '../src/core/bundle.js';
import { fetchSeedBundle } from '../src/core/fetcher.js';
import { readTarballInspectionCache, writeTarballInspectionCache } from '../src/core/tarball.js';
import type { RegistryClient } from '../src/core/registry.js';

describe('persistent tarball inspection cache', () => {
  let tempDir: string;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-tarball-cache-'));
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.remove(tempDir);
  });

  it('uses a persisted manifest on the second fetch after verifying current bytes', async () => {
    const sourceDir = path.join(tempDir, 'source');
    const packageDir = path.join(sourceDir, 'package');
    const tarballPath = path.join(tempDir, 'demo-1.0.0.tgz');
    const bundleDir = path.join(tempDir, 'bundle');
    await fs.ensureDir(packageDir);
    await fs.writeJson(path.join(packageDir, 'package.json'), {
      name: 'demo',
      scripts: { postinstall: 'node setup.js' },
      version: '1.0.0',
    });
    await tar.c({ cwd: sourceDir, file: tarballPath, gzip: true }, ['package']);
    const bytes = await fs.readFile(tarballPath);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const registry: RegistryClient = {
      getPackageMetadata() {
        return Promise.resolve({
          name: 'demo',
          versions: {
            '1.0.0': {
              name: 'demo',
              version: '1.0.0',
              dist: {
                integrity,
                tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
              },
            },
          },
        });
      },
    };
    const requirements = [
      {
        name: 'demo',
        raw: 'demo@1.0.0',
        requiredBy: 'root',
        specifier: '1.0.0',
        type: 'version' as const,
      },
    ];
    fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const firstCache = await readTarballInspectionCache(bundleDir);

    const first = await fetchSeedBundle({
      inspectionCache: firstCache,
      outputDir: bundleDir,
      registry,
      requirements,
    });
    const documents = createBundleDocuments({
      outputDir: bundleDir,
      resolved: first.resolved,
      sourceRegistry: 'https://registry.example',
      tagRequirements: first.tagRequirements,
    });
    await writeBundleDocuments(bundleDir, documents);
    await writeTarballInspectionCache(bundleDir, firstCache, '2026-08-10T00:00:00.000Z');

    const secondCache = await readTarballInspectionCache(bundleDir);
    const second = await fetchSeedBundle({
      inspectionCache: secondCache,
      outputDir: bundleDir,
      registry,
      requirements,
    });

    expect(first).toMatchObject({ downloaded: 1, skipped: 0 });
    expect(first.timings.tarballCacheWrites).toBe(1);
    expect(second).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(second.timings.tarballCacheHits).toBe(1);
    expect(secondCache.persistentHits).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
