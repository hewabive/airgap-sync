import { describe, expect, it } from 'vitest';
import {
  createBundleDocuments,
  createFetchReport,
  dependencySpecsFromManifest,
  mergeBundleDocuments,
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

  it('preserves collected resolution reasons in seed manifest packages', () => {
    const documents = createBundleDocuments({
      createdAt: '2026-05-20T00:00:00.000Z',
      outputDir: './airgap-bundle',
      resolved: [
        {
          ...resolvedPackage,
          resolvedFrom: [
            {
              raw: '@scope/demo@^1.0.0',
              requiredBy: 'parent@1.0.0',
              specifier: '^1.0.0',
              type: 'range',
            },
            {
              raw: '@scope/demo@1.2.3',
              requiredBy: 'lockfile:package-lock.json',
              specifier: '1.2.3',
              type: 'version',
            },
          ],
        },
      ],
      sourceRegistry: 'https://registry.example',
      tagRequirements: [],
    });

    expect(documents.manifest.packages[0]?.resolvedFrom).toEqual([
      {
        raw: '@scope/demo@^1.0.0',
        requiredBy: 'parent@1.0.0',
        specifier: '^1.0.0',
        type: 'range',
      },
      {
        raw: '@scope/demo@1.2.3',
        requiredBy: 'lockfile:package-lock.json',
        specifier: '1.2.3',
        type: 'version',
      },
    ]);
  });

  it('does not persist computed bundled latest requirements', () => {
    const documents = createBundleDocuments({
      createdAt: '2026-05-20T00:00:00.000Z',
      outputDir: './airgap-bundle',
      resolved: [
        {
          ...resolvedPackage,
          raw: '@scope/demo@1.0.0',
          resolvedVia: 'version',
          specifier: '1.0.0',
          type: 'version',
          version: '1.0.0',
        },
        resolvedPackage,
      ],
      sourceRegistry: 'https://registry.example',
      tagRequirements: [],
    });

    expect(documents.distTagsManifest).toEqual({
      schemaVersion: 1,
      createdAt: '2026-05-20T00:00:00.000Z',
      sourceRegistry: 'https://registry.example',
      tags: {},
      requirements: [],
    });
  });

  it('keeps explicit latest requirements in bundled latest mode', () => {
    const documents = createBundleDocuments({
      createdAt: '2026-05-20T00:00:00.000Z',
      outputDir: './airgap-bundle',
      resolved: [
        resolvedPackage,
        {
          ...resolvedPackage,
          raw: '@scope/demo@2.0.0-beta.1',
          resolvedVia: 'version',
          specifier: '2.0.0-beta.1',
          type: 'version',
          version: '2.0.0-beta.1',
        },
      ],
      sourceRegistry: 'https://registry.example',
      tagRequirements: [
        {
          name: '@scope/demo',
          requiredBy: 'root',
          tag: 'latest',
          version: '1.2.3',
        },
        {
          name: '@scope/demo',
          requiredBy: 'airgap-sync:publish-latest',
          tag: 'latest',
          version: '2.0.0-beta.1',
        },
      ],
    });

    expect(documents.distTagsManifest.tags).toEqual({
      '@scope/demo': {
        latest: '1.2.3',
      },
    });
    expect(documents.distTagsManifest.requirements).toEqual([
      {
        name: '@scope/demo',
        requiredBy: 'root',
        tag: 'latest',
        version: '1.2.3',
      },
    ]);
  });
});

describe('mergeBundleDocuments', () => {
  it('retains the previous graph while current packages and tag mappings win', () => {
    const retained = createBundleDocuments({
      createdAt: '2026-05-20T00:00:00.000Z',
      outputDir: './airgap-bundle',
      resolved: [
        resolvedPackage,
        {
          ...resolvedPackage,
          name: 'retained-dependency',
          raw: 'retained-dependency@^1.0.0',
          requiredBy: '@scope/demo@1.2.3',
          resolvedVia: 'range',
          specifier: '^1.0.0',
          type: 'range',
          version: '1.0.0',
        },
      ],
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
    const current = createBundleDocuments({
      createdAt: '2026-05-21T00:00:00.000Z',
      outputDir: './airgap-bundle',
      resolved: [
        {
          ...resolvedPackage,
          raw: '@scope/demo@next',
          specifier: 'next',
          version: '2.0.0',
        },
      ],
      sourceRegistry: 'https://registry.example',
      tagRequirements: [
        {
          name: '@scope/demo',
          requiredBy: 'root',
          tag: 'latest',
          version: '2.0.0',
        },
      ],
    });

    const merged = mergeBundleDocuments(current, retained);

    expect(merged.manifest.createdAt).toBe('2026-05-21T00:00:00.000Z');
    expect(merged.manifest.packages.map(({ name, version }) => `${name}@${version}`)).toEqual([
      '@scope/demo@1.2.3',
      '@scope/demo@2.0.0',
      'retained-dependency@1.0.0',
    ]);
    expect(merged.distTagsManifest.tags).toEqual({
      '@scope/demo': { latest: '2.0.0' },
    });
    expect(merged.distTagsManifest.requirements).toEqual([
      {
        name: '@scope/demo',
        requiredBy: 'root',
        tag: 'latest',
        version: '2.0.0',
      },
    ]);
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
      downloadedPackages: [],
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
      wouldDownloadPackages: [],
    });
  });

  it('records release-age warnings with requirement provenance', () => {
    expect(
      createFetchReport({
        downloaded: 1,
        errors: [],
        generatedAt: '2026-08-12T00:00:00.000Z',
        gitRequirements: [],
        resolved: 1,
        skipped: 0,
        unsupported: [],
        warnings: [
          {
            code: 'release-age-bypass',
            minReleaseAgeDays: 3,
            name: 'tsx',
            publishedAt: '2026-08-10T03:41:31.093Z',
            raw: 'tsx@4.23.12',
            reason: 'fresh exact lockfile version',
            requiredBy: 'lockfile:80.74.26.190/hewabive/shturval/package-lock.json',
            specifier: '4.23.12',
            type: 'version',
            version: '4.23.12',
          },
        ],
      })
    ).toMatchObject({
      errors: [],
      warnings: [
        {
          name: 'tsx',
          requiredBy: 'lockfile:80.74.26.190/hewabive/shturval/package-lock.json',
          version: '4.23.12',
        },
      ],
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
      d: '^4.0.0',
    },
    peerDependenciesMeta: {
      d: {
        optional: true,
      },
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
