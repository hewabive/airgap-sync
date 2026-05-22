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
    const progress: string[] = [];
    const result = await fetchSeedBundle({
      onProgress(event) {
        progress.push(`${event.phase}:${event.status}`);
      },
      outputDir: '/virtual/seed',
      registry,
      requirements: [requirement({})],
    });

    expect(progress).toContain('resolve:start');
    expect(progress).toContain('resolve:progress');
    expect(progress).toContain('download:progress');
    expect(progress.at(-1)).toBe('resolve:done');
    expect(result.resolved.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'demo@1.0.0',
      'demo@2.0.0',
    ]);
    expect(result.tagRequirements).toEqual([
      {
        name: 'demo',
        requiredBy: 'airgap-sync:publish-latest',
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
        requiredBy: 'airgap-sync:publish-latest',
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

  it('resolves independent root requirements concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const concurrentRegistry: RegistryClient = {
      async getPackageMetadata(name) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return {
          name,
          'dist-tags': {
            latest: '1.0.0',
          },
          versions: {
            '1.0.0': {
              name,
              version: '1.0.0',
              dist: { tarball: `https://registry.example/${name}/-/${name}-1.0.0.tgz` },
            },
          },
        };
      },
    };

    const result = await fetchSeedBundle({
      concurrency: 2,
      download: false,
      outputDir: '/virtual/seed',
      registry: concurrentRegistry,
      requirements: [
        requirement({
          name: 'alpha',
          raw: 'alpha@latest',
          specifier: 'latest',
          type: 'tag',
        }),
        requirement({
          name: 'beta',
          raw: 'beta@latest',
          specifier: 'latest',
          type: 'tag',
        }),
      ],
    });

    expect(maxInFlight).toBe(2);
    expect(result.resolved.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'alpha@1.0.0',
      'beta@1.0.0',
    ]);
  });

  it('keeps scheduling newly discovered dependencies concurrently', async () => {
    const dependencyNames = new Set(['dep-a', 'dep-b']);
    let dependencyRequestsInFlight = 0;
    let maxDependencyRequestsInFlight = 0;
    const concurrentRegistry: RegistryClient = {
      async getPackageMetadata(name) {
        if (dependencyNames.has(name)) {
          dependencyRequestsInFlight++;
          maxDependencyRequestsInFlight = Math.max(
            maxDependencyRequestsInFlight,
            dependencyRequestsInFlight
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          dependencyRequestsInFlight--;
        }

        if (name === 'root') {
          return {
            name: 'root',
            'dist-tags': {
              latest: '1.0.0',
            },
            versions: {
              '1.0.0': {
                name: 'root',
                version: '1.0.0',
                dependencies: {
                  'dep-a': 'latest',
                  'dep-b': 'latest',
                },
                dist: { tarball: 'https://registry.example/root/-/root-1.0.0.tgz' },
              },
            },
          };
        }

        expect(dependencyNames.has(name)).toBe(true);
        return {
          name,
          'dist-tags': {
            latest: '1.0.0',
          },
          versions: {
            '1.0.0': {
              name,
              version: '1.0.0',
              dist: { tarball: `https://registry.example/${name}/-/${name}-1.0.0.tgz` },
            },
          },
        };
      },
    };

    const result = await fetchSeedBundle({
      concurrency: 2,
      download: false,
      outputDir: '/virtual/seed',
      registry: concurrentRegistry,
      requirements: [
        requirement({
          name: 'root',
          raw: 'root@latest',
          specifier: 'latest',
          type: 'tag',
        }),
      ],
    });

    expect(maxDependencyRequestsInFlight).toBe(2);
    expect(result.resolved.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'dep-a@1.0.0',
      'dep-b@1.0.0',
      'root@1.0.0',
    ]);
  });
});
