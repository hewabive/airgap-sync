import { describe, expect, it } from 'vitest';
import { packageName, packageVersion } from '../src/index.js';
import type { BundleManifest } from '../src/types.js';

describe('package scaffold', () => {
  it('exports the package name', () => {
    expect(packageName).toBe('airgap-sync');
    expect(packageVersion).toBe('0.1.0');
  });

  it('defines the bundle manifest contract', () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      createdAt: '2026-05-20T00:00:00.000Z',
      sourceRegistry: 'https://registry.npmjs.org',
      packages: [],
    };

    expect(manifest.schemaVersion).toBe(1);
  });
});
