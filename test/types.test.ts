import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.js';
import type { BundleManifest } from '../src/types.js';

describe('package scaffold', () => {
  it('exports the package name', () => {
    expect(packageName).toBe('airgap-sync');
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
