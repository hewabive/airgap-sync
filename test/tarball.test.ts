import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
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

  it('retries transient tarball download failures', async () => {
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
      .mockResolvedValueOnce(new Response('tarball bytes', { status: 200 }));

    const downloaded = await downloadResolvedPackage(pkg, tempDir);

    await expect(fs.readFile(downloaded.path, 'utf8')).resolves.toBe('tarball bytes');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resumes an npm tarball after the response stalls', async () => {
    const content = Buffer.from('tarball bytes that continue after reconnecting');
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
