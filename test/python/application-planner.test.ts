import { describe, expect, it } from 'vitest';
import {
  generatePythonPlannerCandidates,
  planPythonApplication,
  type PythonPlannerPolicy,
} from '../../src/core/python/application-planner.js';
import type { PythonApplicationIntent } from '../../src/core/python/application-intent.js';
import { normalizePlatformCoveragePolicy } from '../../src/core/python/coverage-policy.js';
import type {
  PythonIndexClient,
  PythonIndexFile,
  PythonProjectIndex,
} from '../../src/core/python/index-client.js';
import type {
  PythonApplicationResolver,
  UvResolveRequest,
  UvResolutionEvidence,
} from '../../src/core/python/uv-adapter.js';
import { UvResolutionError } from '../../src/core/python/uv-adapter.js';

const digest = (character: string): string => character.repeat(64);

function file(filename: string, hash: string, size: number): PythonIndexFile {
  return {
    filename,
    hashes: {
      sha256: digest(hash),
    },
    size,
    url: `https://example.test/${filename}`,
  };
}

const projects = new Map<string, PythonProjectIndex>([
  [
    'demo-app',
    {
      apiVersion: '1.0',
      files: [
        file('demo_app-2.0.0-py3-none-any.whl', '2', 20),
        file('demo_app-1.0.0-py3-none-any.whl', '1', 10),
      ],
      name: 'demo-app',
    },
  ],
  [
    'native-dep',
    {
      apiVersion: '1.0',
      files: [
        file('native_dep-4.0.0-cp311-cp311-win_amd64.whl', 'a', 100),
        file('native_dep-4.0.0-cp311-cp311-manylinux_2_28_x86_64.whl', 'b', 110),
        file('native_dep-4.0.0-cp311-cp311-manylinux_2_35_x86_64.whl', 'c', 120),
      ],
      name: 'native-dep',
    },
  ],
]);

class FixtureIndex implements PythonIndexClient {
  readonly sourceIndex = 'https://example.test/simple/';

  getMetadata(): Promise<never> {
    return Promise.reject(new Error('metadata is not needed by this fixture'));
  }

  getProject(name: string): Promise<PythonProjectIndex> {
    const project = projects.get(name);
    if (!project) {
      return Promise.reject(new Error(`missing fixture project ${name}`));
    }
    return Promise.resolve(project);
  }
}

function lockEvidence(version: string): UvResolutionEvidence {
  return {
    content: `fixture ${version}`,
    digest: digest(version === '1.0.0' ? 'd' : 'e'),
    lock: {
      createdBy: 'uv 0.11.16',
      defaultGroups: [],
      dependencyGroups: [],
      environments: [],
      extras: [],
      format: 'pylock',
      packages: [
        {
          dependencies: [{ name: 'native-dep' }],
          devDependencies: {},
          name: 'demo-app',
          optionalDependencies: {},
          sourceKind: 'registry',
          version,
          wheels: [],
        },
        {
          dependencies: [],
          devDependencies: {},
          name: 'native-dep',
          optionalDependencies: {},
          sourceKind: 'registry',
          version: '4.0.0',
          wheels: [],
        },
      ],
      sourcePath: 'fixture.pylock.toml',
      version: '1.0',
    },
    platformTarget: 'fixture',
  };
}

class FixtureResolver implements PythonApplicationResolver {
  readonly requests: UvResolveRequest[] = [];

  resolve(request: UvResolveRequest): Promise<UvResolutionEvidence> {
    this.requests.push(request);
    if (request.requirement.includes('==2.0.0')) {
      return Promise.reject(
        new UvResolutionError('no-wheel', 'demo-app 2.0.0 has no Windows wheel')
      );
    }
    return Promise.resolve(lockEvidence('1.0.0'));
  }
}

const intent: PythonApplicationIntent = {
  application: {
    extras: [],
    features: {},
    name: 'demo-app',
  },
  coverage: {
    policyId: 'desktop-x64',
  },
  python: {
    policy: 'auto',
  },
  source: {
    type: 'pypi',
  },
  updatePolicy: 'manual',
};

const plannerPolicy: PythonPlannerPolicy = {
  glibcBaselines: ['2.17', '2.28', '2.35'],
  pythonMinors: ['3.11'],
  version: 1,
};

describe('Python application planner', () => {
  it('generates a bounded candidate matrix independent from the collector', () => {
    const candidates = generatePythonPlannerCandidates({
      applicationVersions: ['2.0.0', '1.0.0'],
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
      }),
      intent,
      plannerPolicy,
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      applicationVersion: '2.0.0',
      platforms: [
        {
          platformFamilyId: 'windows-x86_64',
        },
        {
          glibc: '2.17',
          platformFamilyId: 'linux-glibc-x86_64',
        },
        {
          glibc: '2.28',
          platformFamilyId: 'linux-glibc-x86_64',
        },
        {
          glibc: '2.35',
          platformFamilyId: 'linux-glibc-x86_64',
        },
      ],
      pythonMinor: '3.11',
    });
  });

  it('selects complete coverage, searches glibc floors, and collects every wheel variant', async () => {
    const resolver = new FixtureResolver();
    const result = await planPythonApplication({
      cacheDir: '/cache',
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
      }),
      createdAt: '2026-07-27T00:00:00.000Z',
      index: new FixtureIndex(),
      intent,
      plannerPolicy,
      resolver,
      uvPath: '/tools/uv',
      workDir: '/work',
    });

    expect(result.plan.application).toEqual({
      name: 'demo-app',
      version: '1.0.0',
    });
    expect(result.plan.preferredPythonMinor).toBe('3.11');
    expect(result.plan.platforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platformFamilyId: 'windows-x86_64',
          status: 'supported',
        }),
        expect.objectContaining({
          platformFamilyId: 'linux-glibc-x86_64',
          status: 'supported',
          supportBoundary: {
            glibc: '2.28',
          },
        }),
      ])
    );
    expect(
      result.plan.wheels
        .filter((wheel) => wheel.package === 'native-dep')
        .map((wheel) => wheel.filename)
    ).toEqual([
      'native_dep-4.0.0-cp311-cp311-manylinux_2_28_x86_64.whl',
      'native_dep-4.0.0-cp311-cp311-manylinux_2_35_x86_64.whl',
      'native_dep-4.0.0-cp311-cp311-win_amd64.whl',
    ]);
    expect(
      result.plan.wheels.find((wheel) => wheel.filename.includes('demo_app-1.0.0'))?.platforms
    ).toEqual(['linux-glibc-x86_64', 'windows-x86_64']);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          glibc: '2.28',
          platformFamilyId: 'linux-glibc-x86_64',
        }),
      ])
    );
    expect(result.rejectedCandidates[0]).toMatchObject({
      applicationVersion: '2.0.0',
      platformFamilyId: 'windows-x86_64',
    });
    expect(
      resolver.requests.some(
        (request) =>
          request.requirement === 'demo-app==1.0.0' &&
          request.platformFamilyId === 'linux-glibc-x86_64' &&
          request.glibc === '2.17'
      )
    ).toBe(true);
  });

  it('reproduces the same semantic plan across runs with a fixed index cutoff', async () => {
    const cutoff = '2026-07-27T00:00:00.000Z';
    const coveragePolicy = normalizePlatformCoveragePolicy({
      id: 'desktop-x64',
      platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
    });
    const firstResolver = new FixtureResolver();
    const secondResolver = new FixtureResolver();
    const first = await planPythonApplication({
      cacheDir: '/cache/first',
      coveragePolicy,
      createdAt: '2026-07-27T01:00:00.000Z',
      cutoff,
      index: new FixtureIndex(),
      intent,
      plannerPolicy,
      resolver: firstResolver,
      uvPath: '/tools/uv',
      workDir: '/work/first',
    });
    const second = await planPythonApplication({
      cacheDir: '/cache/second',
      coveragePolicy,
      createdAt: '2026-07-28T01:00:00.000Z',
      cutoff,
      index: new FixtureIndex(),
      intent,
      plannerPolicy,
      resolver: secondResolver,
      uvPath: '/tools/uv',
      workDir: '/work/second',
    });

    expect(second.plan.planId).toBe(first.plan.planId);
    expect(second.plan.wheels).toEqual(first.plan.wheels);
    expect(
      [...firstResolver.requests, ...secondResolver.requests].every(
        (request) => request.cutoff === cutoff
      )
    ).toBe(true);
  });
});
