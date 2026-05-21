import { describe, expect, it } from 'vitest';
import {
  createBundleDocuments,
  createFetchReport,
  dependencySpecsFromManifest,
  packageFileName,
} from '../src/index.js';
import type { PackageManifest, ResolvedRootPackage } from '../src/types.js';

const resolvedPackage: ResolvedRootPackage = {
  name: '@scope/demo',
  version: '1.2.3',
  dist: {
    tarball: 'https://registry.example/@scope/demo/-/demo-1.2.3.tgz',
  },
  raw: '@scope/demo@latest',
  requiredBy: 'root',
  resolvedVia: 'tag',
  specifier: 'latest',
  type: 'tag',
};

describe('packageFileName', () => {
  it('creates filesystem-safe names for scoped and unscoped packages', () => {
    expect(packageFileName('demo', '1.0.0')).toBe('demo-1.0.0.tgz');
    expect(packageFileName('@scope/demo', '1.0.0')).toBe('scope__demo-1.0.0.tgz');
  });
});

describe('createBundleDocuments', () => {
  it('creates seed and dist-tag manifests', () => {
    const documents = createBundleDocuments({
      createdAt: '2026-05-20T00:00:00.000Z',
      outputDir: './airgap-bundle',
      resolved: [resolvedPackage],
      sourceRegistry: 'https://registry.example',
      tagRequirements: [
        {
          name: '@scope/demo',
          requiredBy: 'root',
          tag: 'latest',
          version: '1.2.3',
        },
      ],
    });

    expect(documents.manifest).toEqual({
      schemaVersion: 1,
      createdAt: '2026-05-20T00:00:00.000Z',
      sourceRegistry: 'https://registry.example',
      packages: [
        {
          name: '@scope/demo',
          version: '1.2.3',
          file: 'packages/scope__demo-1.2.3.tgz',
          tarball: 'https://registry.example/@scope/demo/-/demo-1.2.3.tgz',
          resolvedFrom: [
            {
              raw: '@scope/demo@latest',
              requiredBy: 'root',
              specifier: 'latest',
              type: 'tag',
            },
          ],
        },
      ],
    });

    expect(documents.distTagsManifest.tags).toEqual({
      '@scope/demo': {
        latest: '1.2.3',
      },
    });
  });
});

describe('createFetchReport', () => {
  it('creates a stable operational report shape', () => {
    expect(
      createFetchReport({
        downloaded: 1,
        errors: [],
        generatedAt: '2026-05-20T00:00:00.000Z',
        gitRequirements: [],
        resolved: 1,
        skipped: 0,
        unsupported: [],
      })
    ).toEqual({
      downloaded: 1,
      errors: [],
      generatedAt: '2026-05-20T00:00:00.000Z',
      gitRequirements: [],
      resolved: 1,
      skipped: 0,
      timings: {
        dependencyScanMs: 0,
        downloadMs: 0,
        manifestReadMs: 0,
        resolveMs: 0,
        totalMs: 0,
      },
      unsupported: [],
    });
  });
});

describe('dependencySpecsFromManifest', () => {
  const manifest: PackageManifest = {
    name: 'demo',
    version: '1.0.0',
    dependencies: {
      a: '^1.0.0',
    },
    optionalDependencies: {
      b: 'latest',
    },
    peerDependencies: {
      c: '^3.0.0',
    },
  };

  it('includes dependencies and optionalDependencies by default', () => {
    expect(dependencySpecsFromManifest(manifest)).toEqual({
      a: '^1.0.0',
      b: 'latest',
    });
  });

  it('can include peerDependencies', () => {
    expect(dependencySpecsFromManifest(manifest, { includePeer: true })).toEqual({
      a: '^1.0.0',
      b: 'latest',
      c: '^3.0.0',
    });
  });
});
