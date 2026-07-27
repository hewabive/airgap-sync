import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

interface UvAsset {
  file: string;
  sha256: string;
  size: number;
  url: string;
}

interface UvToolManifest {
  assets: Record<string, UvAsset>;
  license: string;
  licenseFiles: { name: string; sha256: string; url: string }[];
  name: string;
  releaseUrl: string;
  schemaVersion: number;
  version: string;
}

describe('pinned uv tool manifest', () => {
  it('pins supported collector assets and license files by SHA-256', async () => {
    const content = await fs.readFile(path.resolve('support/python/uv-tool-manifest.json'), 'utf8');
    const manifest = JSON.parse(content) as UvToolManifest;

    expect(manifest).toMatchObject({
      license: 'Apache-2.0 OR MIT',
      name: 'uv',
      schemaVersion: 1,
      version: '0.11.16',
    });
    expect(Object.keys(manifest.assets).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);
    expect(manifest.releaseUrl).toBe(
      `https://github.com/astral-sh/uv/releases/tag/${manifest.version}`
    );

    for (const [key, asset] of Object.entries(manifest.assets)) {
      expect(key).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/);
      expect(asset.url).toBe(
        `https://github.com/astral-sh/uv/releases/download/${manifest.version}/${asset.file}`
      );
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.size).toBeGreaterThan(1_000_000);
    }
    for (const license of manifest.licenseFiles) {
      expect(license.name).toMatch(/^LICENSE-/);
      expect(license.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
      expect(license.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
