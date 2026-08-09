import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as fs from '../src/core/fs.js';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadResolvedPackage,
  inspectPackageTarball,
  readPackageManifest,
  TarballInspectionCache,
} from '../src/core/tarball.js';
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

  it('reuses a single physical inspection when later checks need the same digests', async () => {
    const tarballPath = await createTarball('package');
    const bytes = await fs.readFile(tarballPath);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const cache = new TarballInspectionCache();

    const downloaded = await inspectPackageTarball(tarballPath, { integrity }, cache);
    const scanned = await inspectPackageTarball(
      tarballPath,
      { integrity, sha256: downloaded.digests.sha256 },
      cache
    );

    expect(scanned).toBe(downloaded);
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(1);
  });

  it('invalidates cached inspections when a tarball changes', async () => {
    const tarballPath = await createTarball('package');
    const cache = new TarballInspectionCache();

    const first = await inspectPackageTarball(tarballPath, {}, cache);
    await fs.writeJson(path.join(tempDir, 'package', 'package.json'), {
      name: '@types/hast',
      padding: 'x'.repeat(1024),
      version: '3.0.5',
    });
    await tar.c(
      {
        cwd: tempDir,
        file: tarballPath,
        gzip: true,
      },
      ['package']
    );

    const second = await inspectPackageTarball(tarballPath, {}, cache);

    expect(second.manifest.version).toBe('3.0.5');
    expect(second.digests.sha256).not.toBe(first.digests.sha256);
    expect(cache.misses).toBe(2);
    expect(cache.hits).toBe(0);
  });

  it('computes only the digest algorithms required by the current checks', async () => {
    const tarballPath = await createTarball('package');
    const bytes = await fs.readFile(tarballPath);

    const sha256Only = await inspectPackageTarball(tarballPath);
    const registryDigests = await inspectPackageTarball(tarballPath, {
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
    });

    expect(sha256Only.digests).not.toHaveProperty('sha1');
    expect(sha256Only.digests).not.toHaveProperty('sha384Base64');
    expect(sha256Only.digests).not.toHaveProperty('sha512Base64');
    expect(registryDigests.digests).toMatchObject({
      sha1: createHash('sha1').update(bytes).digest('hex'),
      sha512Base64: createHash('sha512').update(bytes).digest('base64'),
    });
    expect(registryDigests.digests).not.toHaveProperty('sha384Base64');
  });

  it('downloads tarballs with fetch streams', async () => {
    const tarballBytes = await fs.readFile(await createTarball('package'));
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
    fetchMock.mockResolvedValue(new Response(tarballBytes, { status: 200 }));

    const downloaded = await downloadResolvedPackage(pkg, tempDir);

    await expect(fs.readFile(downloaded.path)).resolves.toEqual(tarballBytes);
    expect(downloaded).toMatchObject({
      file: 'packages/demo-1.0.0.tgz',
      name: 'demo',
      skipped: false,
      version: '1.0.0',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    const firstInput = firstCall?.[0];
    const firstUrl =
      typeof firstInput === 'string'
        ? firstInput
        : firstInput instanceof URL
          ? firstInput.href
          : firstInput?.url;
    expect(firstUrl).toBe('https://registry.example/demo/-/demo-1.0.0.tgz');
    expect(firstCall?.[1]?.signal).toBeDefined();
  });

  it('records SHA-256 and verifies registry SRI', async () => {
    const bytes = await fs.readFile(await createTarball('package'));
    const pkg: ResolvedRootPackage = {
      dist: {
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
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
    fetchMock.mockResolvedValue(new Response(bytes, { status: 200 }));

    const downloaded = await downloadResolvedPackage(pkg, tempDir);

    expect(downloaded.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('removes a tarball that fails registry integrity verification', async () => {
    const pkg: ResolvedRootPackage = {
      dist: {
        integrity: `sha512-${createHash('sha512').update('expected').digest('base64')}`,
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
    fetchMock.mockResolvedValue(new Response('tampered', { status: 200 }));

    await expect(downloadResolvedPackage(pkg, tempDir)).rejects.toThrow('integrity mismatch');
    await expect(fs.pathExists(path.join(tempDir, 'packages/demo-1.0.0.tgz'))).resolves.toBe(false);
  });

  it('retries transient tarball download failures', async () => {
    const tarballBytes = await fs.readFile(await createTarball('package'));
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
    fetchMock
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
      .mockResolvedValueOnce(new Response(tarballBytes, { status: 200 }));

    const downloaded = await downloadResolvedPackage(pkg, tempDir);

    await expect(fs.readFile(downloaded.path)).resolves.toEqual(tarballBytes);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resumes an npm tarball after the response stalls', async () => {
    const content = await fs.readFile(await createTarball('package'));
    const splitAt = 14;
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
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(content.subarray(0, splitAt));
            },
          }),
          { headers: { 'Content-Length': String(content.byteLength) } }
        )
      )
      .mockResolvedValueOnce(
        new Response(content.subarray(splitAt), {
          headers: {
            'Content-Range': `bytes ${String(splitAt)}-${String(content.byteLength - 1)}/${String(content.byteLength)}`,
          },
          status: 206,
        })
      );

    const downloaded = await downloadResolvedPackage(pkg, tempDir, {
      retryDelaysMs: [1],
      timeoutMs: 20,
    });

    await expect(fs.readFile(downloaded.path)).resolves.toEqual(content);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('range')).toBe(
      `bytes=${String(splitAt)}-`
    );
  });

  it('does not retry missing tarballs', async () => {
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
    fetchMock.mockResolvedValue(new Response('missing', { status: 404 }));

    await expect(downloadResolvedPackage(pkg, tempDir)).rejects.toThrow(
      'Download failed with HTTP 404'
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
