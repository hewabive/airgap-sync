import { describe, expect, it } from 'vitest';
import {
  resolveRootRequirementFromMetadata,
  resolveRootRequirements,
} from '../src/core/resolver.js';
import type { PackageMetadata, RootPackageRequirement } from '../src/types.js';
import type { RegistryClient } from '../src/core/registry.js';

const metadata: PackageMetadata = {
  name: 'demo',
  'dist-tags': {
    beta: '2.0.0-beta.1',
    latest: '1.2.0',
  },
  versions: {
    '1.0.0': {
      name: 'demo',
      version: '1.0.0',
      dist: { tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz' },
    },
    '1.2.0': {
      name: 'demo',
      version: '1.2.0',
      dist: { tarball: 'https://registry.example/demo/-/demo-1.2.0.tgz' },
    },
    '2.0.0-beta.1': {
      name: 'demo',
      version: '2.0.0-beta.1',
      dist: { tarball: 'https://registry.example/demo/-/demo-2.0.0-beta.1.tgz' },
    },
  },
};

function requirement(overrides: Partial<RootPackageRequirement>): RootPackageRequirement {
  return {
    name: 'demo',
    raw: 'demo@latest',
    requiredBy: 'root',
    specifier: 'latest',
    type: 'tag',
    ...overrides,
  };
}

describe('resolveRootRequirementFromMetadata', () => {
  it('resolves tags and records tag requirements', () => {
    const result = resolveRootRequirementFromMetadata(requirement({}), metadata);

    expect(result.error).toBeUndefined();
    expect(result.resolved).toMatchObject({
      name: 'demo',
      raw: 'demo@latest',
      resolvedVia: 'tag',
      specifier: 'latest',
      type: 'tag',
      version: '1.2.0',
    });
    expect(result.tagRequirement).toEqual({
      name: 'demo',
      requiredBy: 'root',
      tag: 'latest',
      version: '1.2.0',
    });
  });

  it('resolves ranges to the highest satisfying version', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({ raw: 'demo@^1.0.0', specifier: '^1.0.0', type: 'range' }),
      metadata
    );

    expect(result.resolved?.version).toBe('1.2.0');
    expect(result.resolved?.resolvedVia).toBe('range');
    expect(result.tagRequirement).toBeUndefined();
  });

  it('prefers latest for ranges when latest satisfies the range', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({ raw: 'demo@^1.0.0', specifier: '^1.0.0', type: 'range' }),
      {
        ...metadata,
        'dist-tags': {
          latest: '1.2.0',
        },
        versions: {
          ...metadata.versions,
          '1.3.0': {
            name: 'demo',
            version: '1.3.0',
            dist: { tarball: 'https://registry.example/demo/-/demo-1.3.0.tgz' },
          },
        },
      }
    );

    expect(result.resolved?.version).toBe('1.2.0');
    expect(result.resolved?.resolvedVia).toBe('range');
  });

  it('falls back to highest satisfying version when latest does not satisfy the range', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({ raw: 'demo@^1.0.0', specifier: '^1.0.0', type: 'range' }),
      {
        ...metadata,
        'dist-tags': {
          latest: '2.0.0-beta.1',
        },
      }
    );

    expect(result.resolved?.version).toBe('1.2.0');
    expect(result.resolved?.resolvedVia).toBe('range');
  });

  it('resolves mixed range and dist-tag alternatives to the newest available version', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({
        name: 'tailwindcss',
        raw: 'tailwindcss@>=3.0.0 || insiders || >=4.0.0-alpha.20 || >=4.0.0-beta.1',
        specifier: '>=3.0.0 || insiders || >=4.0.0-alpha.20 || >=4.0.0-beta.1',
        type: 'range',
      }),
      {
        name: 'tailwindcss',
        'dist-tags': {
          insiders: '4.0.0-insiders.1',
          latest: '4.3.0',
        },
        versions: {
          '3.4.17': {
            name: 'tailwindcss',
            version: '3.4.17',
            dist: { tarball: 'https://registry.example/tailwindcss/-/tailwindcss-3.4.17.tgz' },
          },
          '4.0.0-insiders.1': {
            name: 'tailwindcss',
            version: '4.0.0-insiders.1',
            dist: {
              tarball: 'https://registry.example/tailwindcss/-/tailwindcss-4.0.0-insiders.1.tgz',
            },
          },
          '4.3.0': {
            name: 'tailwindcss',
            version: '4.3.0',
            dist: { tarball: 'https://registry.example/tailwindcss/-/tailwindcss-4.3.0.tgz' },
          },
        },
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.resolved).toMatchObject({
      name: 'tailwindcss',
      resolvedVia: 'range',
      specifier: '>=3.0.0 || insiders || >=4.0.0-alpha.20 || >=4.0.0-beta.1',
      type: 'range',
      version: '4.3.0',
    });
    expect(result.tagRequirement).toBeUndefined();
  });

  it('records the winning tag when a mixed alternative resolves through a dist-tag', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({
        raw: 'demo@insiders || nightly',
        specifier: 'insiders || nightly',
        type: 'range',
      }),
      {
        ...metadata,
        'dist-tags': {
          insiders: '2.0.0-beta.1',
        },
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.resolved).toMatchObject({
      resolvedVia: 'tag',
      specifier: 'insiders || nightly',
      type: 'range',
      version: '2.0.0-beta.1',
    });
    expect(result.tagRequirement).toEqual({
      name: 'demo',
      requiredBy: 'root',
      tag: 'insiders',
      version: '2.0.0-beta.1',
    });
  });

  it('resolves exact versions', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({ raw: 'demo@1.0.0', specifier: '1.0.0', type: 'version' }),
      metadata
    );

    expect(result.resolved?.version).toBe('1.0.0');
    expect(result.resolved?.resolvedVia).toBe('version');
  });

  it('falls back from a fresh latest release during the release-age quarantine', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({}),
      {
        ...metadata,
        time: {
          '1.0.0': '2026-07-01T00:00:00.000Z',
          '1.2.0': '2026-08-08T00:00:00.000Z',
          '2.0.0-beta.1': '2026-07-01T00:00:00.000Z',
        },
      },
      { minReleaseAgeDays: 3, now: new Date('2026-08-09T00:00:00.000Z') }
    );

    expect(result.resolved).toMatchObject({
      publishedAt: '2026-07-01T00:00:00.000Z',
      version: '1.0.0',
    });
    expect(result.tagRequirement?.version).toBe('1.0.0');
  });

  it('keeps a fresh exact version and records a release-age warning', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({
        raw: 'demo@1.2.0',
        requiredBy: 'lockfile:github.com/acme/app/package-lock.json',
        specifier: '1.2.0',
        type: 'version',
      }),
      { ...metadata, time: { '1.2.0': '2026-08-08T00:00:00.000Z' } },
      { minReleaseAgeDays: 3, now: new Date('2026-08-09T00:00:00.000Z') }
    );

    expect(result.error).toBeUndefined();
    expect(result.resolved?.version).toBe('1.2.0');
    expect(result.warning).toMatchObject({
      code: 'release-age-bypass',
      minReleaseAgeDays: 3,
      name: 'demo',
      publishedAt: '2026-08-08T00:00:00.000Z',
      requiredBy: 'lockfile:github.com/acme/app/package-lock.json',
      version: '1.2.0',
    });
    expect(result.warning?.reason).toContain('No eligible version can preserve this requirement');
  });

  it('keeps the newest compatible release with a warning when a range has no mature option', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({ raw: 'demo@^1.0.0', specifier: '^1.0.0', type: 'range' }),
      {
        ...metadata,
        time: {
          '1.0.0': '2026-08-08T00:00:00.000Z',
          '1.2.0': '2026-08-08T12:00:00.000Z',
        },
      },
      { minReleaseAgeDays: 3, now: new Date('2026-08-09T00:00:00.000Z') }
    );

    expect(result.resolved?.version).toBe('1.2.0');
    expect(result.warning).toMatchObject({ code: 'release-age-bypass', version: '1.2.0' });
  });

  it('preserves alias metadata while resolving the target package', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({
        alias: 'my-demo',
        aliasTargetType: 'tag',
        raw: 'my-demo@npm:demo@beta',
        specifier: 'beta',
        type: 'alias',
      }),
      metadata
    );

    expect(result.resolved).toMatchObject({
      alias: 'my-demo',
      name: 'demo',
      resolvedVia: 'tag',
      specifier: 'beta',
      type: 'alias',
      version: '2.0.0-beta.1',
    });
    expect(result.tagRequirement).toEqual({
      name: 'demo',
      requiredBy: 'root',
      tag: 'beta',
      version: '2.0.0-beta.1',
    });
  });

  it('returns an error when a tag is missing', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({ raw: 'demo@next', specifier: 'next' }),
      metadata
    );

    expect(result.error).toEqual({
      name: 'demo',
      raw: 'demo@next',
      reason: 'Tag "next" does not exist',
      requiredBy: 'root',
      specifier: 'next',
      type: 'tag',
    });
  });

  it('returns an error when a range cannot be satisfied', () => {
    const result = resolveRootRequirementFromMetadata(
      requirement({ raw: 'demo@^3.0.0', specifier: '^3.0.0', type: 'range' }),
      metadata
    );

    expect(result.error?.reason).toBe('No version satisfies range "^3.0.0"');
  });
});

describe('resolveRootRequirements', () => {
  it('resolves requirements through a registry client', async () => {
    const registry: RegistryClient = {
      getPackageMetadata(name) {
        expect(name).toBe('demo');
        return Promise.resolve(metadata);
      },
    };

    await expect(resolveRootRequirements([requirement({})], registry)).resolves.toMatchObject({
      errors: [],
      resolved: [{ name: 'demo', version: '1.2.0' }],
      tagRequirements: [{ name: 'demo', tag: 'latest', version: '1.2.0' }],
      warnings: [],
    });
  });
});
