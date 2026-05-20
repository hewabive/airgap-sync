import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSeedBundle } from '../src/core/fetcher.js';
import type {
  PackageManifest,
  PackageMetadata,
  ResolvedRootPackage,
  RootPackageRequirement,
} from '../src/types.js';
import type { RegistryClient } from '../src/core/registry.js';

const tarballMocks = vi.hoisted(() => ({
  dependencySpecsFromManifest: vi.fn(),
  downloadResolvedPackage: vi.fn(),
  manifests: new Map<string, PackageManifest>(),
  readPackageManifest: vi.fn(),
}));

vi.mock('../src/core/tarball.js', () => ({
  dependencySpecsFromManifest: tarballMocks.dependencySpecsFromManifest,
  downloadResolvedPackage: tarballMocks.downloadResolvedPackage,
  readPackageManifest: tarballMocks.readPackageManifest,
}));

const metadata: PackageMetadata = {
  name: 'demo',
  'dist-tags': {
    latest: '2.0.0',
  },
  versions: {
    '1.0.0': {
      name: 'demo',
      version: '1.0.0',
      dist: { tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz' },
    },
    '2.0.0': {
      name: 'demo',
      version: '2.0.0',
      dist: { tarball: 'https://registry.example/demo/-/demo-2.0.0.tgz' },
    },
  },
};

const registry: RegistryClient = {
  getPackageMetadata(name) {
    expect(name).toBe('demo');
    return Promise.resolve(metadata);
  },
};

function requirement(overrides: Partial<RootPackageRequirement>): RootPackageRequirement {
  return {
    name: 'demo',
    raw: 'demo@1.0.0',
    requiredBy: 'root',
    specifier: '1.0.0',
    type: 'version',
    ...overrides,
  };
}

describe('fetchSeedBundle', () => {
  beforeEach(() => {
    tarballMocks.manifests.clear();
    tarballMocks.downloadResolvedPackage.mockReset();
    tarballMocks.readPackageManifest.mockReset();
    tarballMocks.dependencySpecsFromManifest.mockReset();

    tarballMocks.downloadResolvedPackage.mockImplementation((pkg: ResolvedRootPackage) => {
      const filePath = `/virtual/${pkg.name}-${pkg.version}.tgz`;
      tarballMocks.manifests.set(filePath, { name: pkg.name, version: pkg.version });
      return {
        file: `packages/${pkg.name}-${pkg.version}.tgz`,
        name: pkg.name,
        path: filePath,
        skipped: false,
        version: pkg.version,
      };
    });
    tarballMocks.readPackageManifest.mockImplementation((path: string) => {
      const manifest = tarballMocks.manifests.get(path);
      if (!manifest) {
        throw new Error(`Missing manifest for ${path}`);
      }
      return manifest;
    });
    tarballMocks.dependencySpecsFromManifest.mockImplementation(
      (manifest: PackageManifest) => manifest.dependencies ?? {}
    );
  });

  it('adds the upstream latest target for packages resolved by exact version', async () => {
    const result = await fetchSeedBundle({
      outputDir: '/virtual/seed',
      registry,
      requirements: [requirement({})],
    });

    expect(result.resolved.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'demo@1.0.0',
      'demo@2.0.0',
    ]);
    expect(result.tagRequirements).toEqual([
      {
        name: 'demo',
        requiredBy: 'npm-registry-seed:publish-latest',
        tag: 'latest',
        version: '2.0.0',
      },
    ]);
  });

  it('does not duplicate a root latest requirement', async () => {
    const result = await fetchSeedBundle({
      outputDir: '/virtual/seed',
      registry,
      requirements: [
        requirement({
          raw: 'demo@latest',
          specifier: 'latest',
          type: 'tag',
        }),
      ],
    });

    expect(result.resolved.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual(['demo@2.0.0']);
    expect(result.tagRequirements).toHaveLength(1);
    expect(tarballMocks.downloadResolvedPackage).toHaveBeenCalledOnce();
  });

  it('can traverse dependencies without downloading tarballs', async () => {
    const registryWithDependencies: RegistryClient = {
      getPackageMetadata(name) {
        if (name === 'demo') {
          return Promise.resolve({
            name: 'demo',
            'dist-tags': {
              latest: '2.0.0',
            },
            versions: {
              '1.0.0': {
                name: 'demo',
                version: '1.0.0',
                dependencies: {
                  dep: 'latest',
                },
                dist: { tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz' },
              },
              '2.0.0': {
                name: 'demo',
                version: '2.0.0',
                dist: { tarball: 'https://registry.example/demo/-/demo-2.0.0.tgz' },
              },
            },
          });
        }

        expect(name).toBe('dep');
        return Promise.resolve({
          name: 'dep',
          'dist-tags': {
            latest: '1.0.0',
          },
          versions: {
            '1.0.0': {
              name: 'dep',
              version: '1.0.0',
              dist: { tarball: 'https://registry.example/dep/-/dep-1.0.0.tgz' },
            },
          },
        });
      },
    };

    const result = await fetchSeedBundle({
      download: false,
      outputDir: '/virtual/seed',
      registry: registryWithDependencies,
      requirements: [requirement({})],
    });

    expect(result.resolved.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'demo@1.0.0',
      'demo@2.0.0',
      'dep@1.0.0',
    ]);
    expect(result.downloaded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.wouldDownload).toBe(3);
    expect(result.tagRequirements).toEqual([
      {
        name: 'demo',
        requiredBy: 'npm-registry-seed:publish-latest',
        tag: 'latest',
        version: '2.0.0',
      },
      {
        name: 'dep',
        requiredBy: 'demo@1.0.0',
        tag: 'latest',
        version: '1.0.0',
      },
    ]);
    expect(tarballMocks.downloadResolvedPackage).not.toHaveBeenCalled();
    expect(tarballMocks.readPackageManifest).not.toHaveBeenCalled();
  });
});
