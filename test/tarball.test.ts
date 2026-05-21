import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadResolvedPackage, readPackageManifest } from '../src/core/tarball.js';
import type { ResolvedRootPackage } from '../src/types.js';

let tempDir: string;
const fetchMock = vi.fn<typeof fetch>();

async function createTarball(rootDirName: string): Promise<string> {
  const packageDir = path.join(tempDir, rootDirName);
  await fs.ensureDir(packageDir);
  await fs.writeJson(path.join(packageDir, 'package.json'), {
    name: '@types/hast',
    version: '3.0.4',
  });

  const tarballPath = path.join(tempDir, 'package.tgz');
  await tar.c(
    {
      cwd: tempDir,
      file: tarballPath,
      gzip: true,
    },
    [rootDirName]
  );

  return tarballPath;
}

describe('readPackageManifest', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-tarball-'));
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.remove(tempDir);
  });

  it('reads package.json from non-standard tarball root directories', async () => {
    const tarballPath = await createTarball('hast');

    await expect(readPackageManifest(tarballPath)).resolves.toEqual({
      name: '@types/hast',
      version: '3.0.4',
    });
  });

  it('downloads tarballs with fetch streams', async () => {
    const pkg: ResolvedRootPackage = {
      dist: {
        tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
      },
      name: 'demo',
      raw: 'demo@1.0.0',
      requiredBy: 'root',
      resolvedVia: 'version',
      specifier: '1.0.0',
      type: 'version',
      version: '1.0.0',
    };
    fetchMock.mockResolvedValue(new Response('tarball bytes', { status: 200 }));

    const downloaded = await downloadResolvedPackage(pkg, tempDir);

    await expect(fs.readFile(downloaded.path, 'utf8')).resolves.toBe('tarball bytes');
    expect(downloaded).toMatchObject({
      file: 'packages/demo-1.0.0.tgz',
      name: 'demo',
      skipped: false,
      version: '1.0.0',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe('https://registry.example/demo/-/demo-1.0.0.tgz');
    expect(firstCall?.[1]?.signal).toBeDefined();
  });
});
