import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import { acquireUv, uvCollectorAssetKey, uvToolManifest } from '../../src/core/python/uv-tool.js';

let tempDir: string;

describe('pinned uv acquisition', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-uv-tool-'));
  });

  afterEach(async () => {
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

  it('rejects a downloaded asset before extraction when its size is wrong', async () => {
    await expect(
      acquireUv({
        cacheDir: tempDir,
        fetch: () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
        arch: 'x64',
        platform: 'linux',
      })
    ).rejects.toThrow('uv size mismatch');
  });
});
