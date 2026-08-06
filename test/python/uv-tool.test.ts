import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import { acquireUv, uvCollectorAssetKey, uvToolManifest } from '../../src/core/python/uv-tool.js';

let tempDir: string;
const linuxX64Asset = uvToolManifest.assets['linux-x64']!;
const originalLinuxX64Asset = { ...linuxX64Asset };

async function useTinyUvTarball(): Promise<Uint8Array> {
  const fixtureRoot = path.join(tempDir, 'fixture');
  const executableDir = path.join(fixtureRoot, 'uv-test');
  const archive = path.join(tempDir, 'uv-test.tar.gz');
  await fs.ensureDir(executableDir);
  await fs.writeFile(path.join(executableDir, 'uv'), '#!/bin/sh\necho uv test\n');
  await tar.c({ cwd: fixtureRoot, file: archive, gzip: true }, ['uv-test']);
  const content = Uint8Array.from(await fs.readFile(archive));
  Object.assign(linuxX64Asset, {
    file: 'uv-test.tar.gz',
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
    url: 'https://example.test/uv-test.tar.gz',
  });
  return content;
}

describe('pinned uv acquisition', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-uv-tool-'));
  });

  afterEach(async () => {
    Object.assign(linuxX64Asset, originalLinuxX64Asset);
    await fs.remove(tempDir);
  });

  it('loads the reviewed pin and resolves supported collector assets', () => {
    expect(uvToolManifest.version).toBe('0.11.16');
    expect(uvCollectorAssetKey('linux', 'x64')).toBe('linux-x64');
    expect(() => uvCollectorAssetKey('freebsd', 'x64')).toThrow(
      'not available for collector platform'
    );
  });

  it('uses an explicit executable without downloading', async () => {
    await expect(
      acquireUv({
        cacheDir: tempDir,
        uvBin: './tools/uv',
      })
    ).resolves.toBe(path.resolve('./tools/uv'));
  });

  it('reports an incomplete downloaded asset before extraction', async () => {
    await expect(
      acquireUv({
        cacheDir: tempDir,
        fetch: () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
        arch: 'x64',
        platform: 'linux',
        retryDelaysMs: [],
      })
    ).rejects.toThrow('download ended early: received 3 of 24014155 bytes');
  });

  it('resumes an incomplete asset on the next attempt', async () => {
    const content = await useTinyUvTarball();
    const splitAt = Math.floor(content.byteLength / 2);
    const ranges: (string | null)[] = [];
    const retries: number[] = [];
    const fetchMock: typeof globalThis.fetch = (_input, init) => {
      ranges.push(new Headers(init?.headers).get('range'));
      if (ranges.length === 1) {
        return Promise.resolve(new Response(content.subarray(0, splitAt)));
      }
      return Promise.resolve(
        new Response(content.subarray(splitAt), {
          headers: {
            'Content-Range': `bytes ${String(splitAt)}-${String(content.byteLength - 1)}/${String(content.byteLength)}`,
          },
          status: 206,
        })
      );
    };

    const executable = await acquireUv({
      arch: 'x64',
      cacheDir: path.join(tempDir, 'cache'),
      fetch: fetchMock,
      onRetry: (event) => retries.push(event.downloadedBytes),
      platform: 'linux',
      retryDelaysMs: [1],
    });

    expect(ranges).toEqual([null, `bytes=${String(splitAt)}-`]);
    expect(retries).toEqual([splitAt]);
    await expect(fs.readFile(executable, 'utf8')).resolves.toContain('echo uv test');
  });

  it('retries terminated response bodies and reports the underlying cause', async () => {
    let attempts = 0;
    const fetchMock: typeof globalThis.fetch = () => {
      attempts++;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new TypeError('terminated', {
                  cause: new Error('other side closed'),
                })
              );
            },
          })
        )
      );
    };

    await expect(
      acquireUv({
        arch: 'x64',
        cacheDir: tempDir,
        fetch: fetchMock,
        platform: 'linux',
        retryDelaysMs: [1, 1],
      })
    ).rejects.toThrow(
      /Download failed after 3 attempts .*TypeError: terminated; caused by other side closed/u
    );
    expect(attempts).toBe(3);
  });

  it('does not abort a slow body while it keeps receiving data', async () => {
    const content = await useTinyUvTarball();
    const chunkSize = Math.ceil(content.byteLength / 4);
    let offset = 0;
    const fetchMock: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            async pull(controller) {
              await delay(10);
              if (offset >= content.byteLength) {
                controller.close();
                return;
              }
              const end = Math.min(content.byteLength, offset + chunkSize);
              controller.enqueue(content.subarray(offset, end));
              offset = end;
            },
          })
        )
      );

    await expect(
      acquireUv({
        arch: 'x64',
        cacheDir: path.join(tempDir, 'slow-cache'),
        fetch: fetchMock,
        platform: 'linux',
        retryDelaysMs: [],
        stallTimeoutMs: 25,
      })
    ).resolves.toContain('uv-test/uv');
  });

  it('retries after the body stops making progress', async () => {
    const content = await useTinyUvTarball();
    const splitAt = Math.floor(content.byteLength / 2);
    const ranges: (string | null)[] = [];
    const retryReasons: string[] = [];
    const fetchMock: typeof globalThis.fetch = (_input, init) => {
      ranges.push(new Headers(init?.headers).get('range'));
      if (ranges.length === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(content.subarray(0, splitAt));
              },
            })
          )
        );
      }
      return Promise.resolve(
        new Response(content.subarray(splitAt), {
          headers: {
            'Content-Range': `bytes ${String(splitAt)}-${String(content.byteLength - 1)}/${String(content.byteLength)}`,
          },
          status: 206,
        })
      );
    };

    await expect(
      acquireUv({
        arch: 'x64',
        cacheDir: path.join(tempDir, 'stalled-cache'),
        fetch: fetchMock,
        onRetry: (event) =>
          retryReasons.push(event.error instanceof Error ? event.error.message : ''),
        platform: 'linux',
        retryDelaysMs: [1],
        stallTimeoutMs: 20,
      })
    ).resolves.toContain('uv-test/uv');
    expect(ranges).toEqual([null, `bytes=${String(splitAt)}-`]);
    expect(retryReasons).toEqual(['received no data for 20ms']);
  });

  it('adopts a partial archive left by the previous downloader', async () => {
    const content = await useTinyUvTarball();
    const splitAt = Math.floor(content.byteLength / 2);
    const cacheDir = path.join(tempDir, 'legacy-cache');
    const legacyRoot = path.join(
      cacheDir,
      'uv',
      uvToolManifest.version,
      'linux-x64-download-legacy'
    );
    await fs.ensureDir(legacyRoot);
    await fs.writeFile(path.join(legacyRoot, linuxX64Asset.file), content.subarray(0, splitAt));
    let startingBytes = 0;
    const fetchMock: typeof globalThis.fetch = (_input, init) => {
      expect(new Headers(init?.headers).get('range')).toBe(`bytes=${String(splitAt)}-`);
      return Promise.resolve(
        new Response(content.subarray(splitAt), {
          headers: {
            'Content-Range': `bytes ${String(splitAt)}-${String(content.byteLength - 1)}/${String(content.byteLength)}`,
          },
          status: 206,
        })
      );
    };

    await expect(
      acquireUv({
        arch: 'x64',
        cacheDir,
        fetch: fetchMock,
        onDownloadStart: (event) => {
          startingBytes = event.downloadedBytes;
        },
        platform: 'linux',
        retryDelaysMs: [],
      })
    ).resolves.toContain('uv-test/uv');
    expect(startingBytes).toBe(splitAt);
  });
});
