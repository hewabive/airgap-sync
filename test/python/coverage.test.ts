import { describe, expect, it } from 'vitest';
import {
  compareCompatibilityVersions,
  explainPlatformCoveragePolicy,
} from '../../src/core/python/coverage-explain.js';
import {
  builtInDistributionHintCatalog,
  normalizeDistributionHintCatalog,
} from '../../src/core/python/distribution-hints.js';
import {
  getBuiltInPlatformFamily,
  listBuiltInPlatformFamilies,
} from '../../src/core/python/platform-family.js';
import { normalizePlatformCoveragePolicy } from '../../src/core/python/coverage-policy.js';

describe('platform coverage catalog', () => {
  it('defines the initial collector-independent platform families', () => {
    expect(listBuiltInPlatformFamilies()).toEqual([
      {
        architecture: 'x86_64',
        definitionVersion: 1,
        id: 'windows-x86_64',
        os: 'windows',
        status: 'supported',
        wheelPlatformFamilies: ['win_amd64'],
      },
      {
        architecture: 'x86_64',
        definitionVersion: 1,
        id: 'linux-glibc-x86_64',
        libc: 'glibc',
        os: 'linux',
        status: 'supported',
        wheelPlatformFamilies: ['manylinux_x86_64'],
      },
    ]);
    expect(getBuiltInPlatformFamily('windows-x86_64')?.architecture).toBe('x86_64');
    expect(getBuiltInPlatformFamily('unknown')).toBeUndefined();
  });

  it('loads a versioned hint catalog with reviewed provenance', () => {
    expect(normalizeDistributionHintCatalog(builtInDistributionHintCatalog)).toEqual(
      builtInDistributionHintCatalog
    );
    expect(builtInDistributionHintCatalog.catalogVersion).toBe('2026.07');
    expect(builtInDistributionHintCatalog.provenance).toHaveLength(4);
    expect(builtInDistributionHintCatalog.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          distributionId: 'ubuntu',
          libc: {
            family: 'glibc',
            version: '2.35',
          },
          release: '22.04',
        }),
        expect.objectContaining({
          distributionId: 'rocky',
          libc: {
            family: 'glibc',
            version: '2.28',
          },
          release: '8',
        }),
      ])
    );
  });

  it('uses distro hints only to explain an explicit glibc boundary', () => {
    const explanation = explainPlatformCoveragePolicy(
      normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        linux: {
          oldestSupportedGlibc: '2.35',
        },
        platforms: ['linux-glibc-x86_64'],
      })
    );
    const glibc = explanation.platforms[0]?.glibc;
    expect(glibc?.source).toBe('advanced-constraint');
    if (glibc?.source !== 'advanced-constraint') {
      throw new Error('expected an advanced glibc constraint');
    }
    expect(
      glibc.knownCompatibleExamples.map((entry) => `${entry.distributionId}-${entry.release}`)
    ).toContain('ubuntu-22.04');
    expect(
      glibc.knownIncompatibleExamples.map((entry) => `${entry.distributionId}-${entry.release}`)
    ).toContain('rocky-9');
  });

  it('does not invent distro compatibility before planning infers a floor', () => {
    const explanation = explainPlatformCoveragePolicy(
      normalizePlatformCoveragePolicy({
        id: 'linux-x64',
        platforms: ['linux-glibc-x86_64'],
      })
    );
    expect(explanation.platforms[0]?.glibc).toEqual({
      source: 'inferred-during-planning',
    });
    expect(compareCompatibilityVersions('2.39', '2.35')).toBeGreaterThan(0);
  });
});
