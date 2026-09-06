import { describe, expect, it } from 'vitest';
import { formatPythonPlanningWarnings } from '../../src/core/python/planning-diagnostics.js';
import { addPythonRuntimeContract } from '../../src/core/python/runtime-contract.js';
import {
  generatePythonPlannerCandidates,
  planPythonApplication,
  PythonApplicationPlanningError,
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
        file('native_dep-4.0.0-cp312-cp312-win_amd64.whl', 'f', 100),
        file('native_dep-4.0.0-cp312-cp312-manylinux_2_28_x86_64.whl', '8', 110),
        file('native_dep-4.0.0-cp312-cp312-manylinux_2_35_x86_64.whl', '9', 120),
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

  it.each([undefined, '==2.0.0'])(
    'does not pin a target %s through an older recipe',
    async (version) => {
      const recipe = {
        application: 'demo-app',
        compatibility: { applicationVersions: '==1.0.0', requiresPython: '<3.11' },
        requiredExtras: ['old-extra'],
        healthChecks: [{ command: 'old-command', args: [] }],
        systemPrerequisites: ['old prerequisite'],
        id: 'demo-old',
        schemaVersion: 1 as const,
        version: '1',
      };
      const result = await planPythonApplication({
        cacheDir: '/cache',
        coveragePolicy: normalizePlatformCoveragePolicy({
          id: 'desktop-x64',
          platforms: ['windows-x86_64'],
        }),
        index: new FixtureIndex(),
        intent: {
          ...intent,
          application: { ...intent.application, ...(version ? { version } : {}) },
        },
        plannerPolicy,
        recipe,
        resolver: {
          resolve: (request) => {
            expect(request.requirement).toBe('demo-app==2.0.0');
            return Promise.resolve(lockEvidence('2.0.0'));
          },
        },
        uvPath: '/tools/uv',
        workDir: '/work',
      });
      expect(result.plan.application.version).toBe('2.0.0');
      const plan = addPythonRuntimeContract(result.plan, { recipe });
      expect(plan.verification).toBeUndefined();
      expect(plan.runtimeContract?.platforms[0]?.systemPrerequisites).not.toContain(
        'old prerequisite'
      );
    }
  );

  it('keeps selected features within the recipe scope and explains rejected newer versions', async () => {
    const result = await planPythonApplication({
      cacheDir: '/cache',
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        platforms: ['windows-x86_64'],
      }),
      index: new FixtureIndex(),
      intent: { ...intent, application: { ...intent.application, features: { mode: 'cpu' } } },
      plannerPolicy,
      recipe: {
        application: 'demo-app',
        compatibility: { applicationVersions: '==1.0.0' },
        features: [{ name: 'mode', description: 'Mode', values: [{ value: 'cpu' }] }],
        id: 'demo-old',
        schemaVersion: 1,
        version: '1',
      },
      resolver: {
        resolve: (request) => {
          expect(request.requirement).toBe('demo-app==1.0.0');
          return Promise.resolve(lockEvidence('1.0.0'));
        },
      },
      uvPath: '/tools/uv',
      workDir: '/work',
    });
    expect(result.plan.application.version).toBe('1.0.0');
    expect(
      result.rejectedCandidates.some(
        (candidate) =>
          candidate.applicationVersion === '2.0.0' &&
          candidate.reason.includes('selected features require a recipe')
      )
    ).toBe(true);
  });

  it('selects complete coverage, searches glibc floors, and keeps a minimum wheel cover', async () => {
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

  it('rejects an incompatible exact application version without falling back', async () => {
    const resolver = new FixtureResolver();
    const exactIntent: PythonApplicationIntent = {
      ...intent,
      application: {
        ...intent.application,
        version: '==2.0.0',
      },
    };

    await expect(
      planPythonApplication({
        cacheDir: '/cache',
        coveragePolicy: normalizePlatformCoveragePolicy({
          id: 'desktop-x64',
          platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
        }),
        createdAt: '2026-07-27T00:00:00.000Z',
        index: new FixtureIndex(),
        intent: exactIntent,
        plannerPolicy,
        resolver,
        uvPath: '/tools/uv',
        workDir: '/work',
      })
    ).rejects.toBeInstanceOf(PythonApplicationPlanningError);
    expect(resolver.requests).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ requirement: 'demo-app==1.0.0' })])
    );
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

  it('plans every explicitly selected Python minor for one application version', async () => {
    const selectedIntent: PythonApplicationIntent = {
      ...intent,
      python: {
        policy: 'selected',
        versions: ['3.11', '3.12'],
      },
    };
    const result = await planPythonApplication({
      cacheDir: '/cache',
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
      }),
      createdAt: '2026-07-27T00:00:00.000Z',
      index: new FixtureIndex(),
      intent: selectedIntent,
      plannerPolicy,
      resolver: new FixtureResolver(),
      uvPath: '/tools/uv',
      workDir: '/work',
    });

    expect(result.plan.application.version).toBe('1.0.0');
    expect(
      result.plan.platforms.map((platform) => [platform.platformFamilyId, platform.pythonMinor])
    ).toEqual(
      expect.arrayContaining([
        ['windows-x86_64', '3.11'],
        ['linux-glibc-x86_64', '3.11'],
        ['windows-x86_64', '3.12'],
        ['linux-glibc-x86_64', '3.12'],
      ])
    );
  });

  it('keeps every compatible Python minor and reports incomplete minors', async () => {
    const result = await planPythonApplication({
      cacheDir: '/cache',
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
      }),
      createdAt: '2026-07-27T00:00:00.000Z',
      index: new FixtureIndex(),
      intent: {
        ...intent,
        application: { ...intent.application, version: '==1.0.0' },
        python: {
          policy: 'selected',
          versions: ['3.10', '3.11', '3.12', '3.13'],
        },
      },
      plannerPolicy,
      resolver: new FixtureResolver(),
      uvPath: '/tools/uv',
      workDir: '/work',
    });

    expect(
      [...new Set(result.plan.platforms.map((platform) => platform.pythonMinor))].sort()
    ).toEqual(['3.11', '3.12']);
    expect(result.plan.presentation?.requestedPythonMinors).toEqual([
      '3.10',
      '3.11',
      '3.12',
      '3.13',
    ]);
    expect(
      result.plan.presentation?.skippedPythonMinors?.map((skipped) => skipped.pythonMinor)
    ).toEqual(['3.10', '3.13']);
    expect(
      result.plan.presentation?.skippedPythonMinors?.every((skipped) =>
        skipped.reasons.some((reason) => reason.includes('no wheel'))
      )
    ).toBe(true);
  });

  it('skips a root application Requires-Python mismatch without invoking the resolver', async () => {
    class RequiresPythonIndex extends FixtureIndex {
      override getProject(name: string): Promise<PythonProjectIndex> {
        if (name === 'demo-app') {
          return Promise.resolve({
            apiVersion: '1.0',
            files: [
              {
                ...file('demo_app-1.0.0-py3-none-any.whl', '1', 10),
                requiresPython: '>=3.11',
              },
            ],
            name,
          });
        }
        return super.getProject(name);
      }
    }
    const resolver = new FixtureResolver();
    const result = await planPythonApplication({
      cacheDir: '/cache',
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        platforms: ['linux-glibc-x86_64'],
      }),
      createdAt: '2026-07-27T00:00:00.000Z',
      index: new RequiresPythonIndex(),
      intent: {
        ...intent,
        application: { ...intent.application, version: '==1.0.0' },
        python: { policy: 'selected', versions: ['3.10', '3.11'] },
      },
      plannerPolicy,
      resolver,
      uvPath: '/tools/uv',
      workDir: '/work',
    });

    expect(result.plan.presentation?.skippedPythonMinors).toEqual([
      {
        pythonMinor: '3.10',
        reasons: ['application-incompatible: application files require Python >=3.11'],
      },
    ]);
    expect(resolver.requests.some((request) => request.pythonMinor === '3.10')).toBe(false);
    expect(resolver.requests.some((request) => request.pythonMinor === '3.11')).toBe(true);
  });

  it('selects the latest application release with at least one complete Python minor', async () => {
    class PartialLatestResolver extends FixtureResolver {
      override resolve(request: UvResolveRequest): Promise<UvResolutionEvidence> {
        this.requests.push(request);
        if (request.requirement.includes('==2.0.0') && request.pythonMinor === '3.11') {
          return Promise.reject(new UvResolutionError('no-wheel', 'no Python 3.11 wheel'));
        }
        return Promise.resolve(
          lockEvidence(request.requirement.includes('==2.0.0') ? '2.0.0' : '1.0.0')
        );
      }
    }

    const result = await planPythonApplication({
      cacheDir: '/cache',
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
      }),
      createdAt: '2026-07-27T00:00:00.000Z',
      index: new FixtureIndex(),
      intent: {
        ...intent,
        python: { policy: 'selected', versions: ['3.11', '3.12'] },
      },
      plannerPolicy,
      resolver: new PartialLatestResolver(),
      uvPath: '/tools/uv',
      workDir: '/work',
    });

    expect(result.plan.application.version).toBe('2.0.0');
    expect([...new Set(result.plan.platforms.map((platform) => platform.pythonMinor))]).toEqual([
      '3.12',
    ]);
    expect(
      result.plan.presentation?.skippedPythonMinors?.map((skipped) => skipped.pythonMinor)
    ).toEqual(['3.11']);
    expect(
      result.plan.presentation?.skippedPythonMinors?.[0]?.reasons.some((reason) =>
        reason.includes('no-wheel')
      )
    ).toBe(true);
  });

  it('reports progress, preserves resolver details, and warns on fallback and skipped Python', async () => {
    const progress: string[] = [];
    const detail =
      'No solution found: native-dep has no usable wheels.\nBuilding from source is disabled.';
    const result = await planPythonApplication({
      cacheDir: '/cache',
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        platforms: ['linux-glibc-x86_64'],
      }),
      index: new FixtureIndex(),
      intent: { ...intent, python: { policy: 'selected', versions: ['3.11', '3.12'] } },
      onProgress: (candidate) =>
        progress.push(
          `${candidate.applicationVersion}/${candidate.pythonMinor}/${candidate.glibc ?? 'none'}`
        ),
      plannerPolicy,
      resolver: {
        resolve: (request) => {
          expect(progress.at(-1)).toContain(`/${request.pythonMinor}/${request.glibc ?? 'none'}`);
          if (request.requirement.includes('2.0.0') || request.pythonMinor === '3.12') {
            return Promise.reject(
              new UvResolutionError('no-solution', 'Resolution failed', detail)
            );
          }
          return Promise.resolve(lockEvidence('1.0.0'));
        },
      },
      uvPath: '/tools/uv',
      workDir: '/work',
    });
    expect(progress[0]).toBe('2.0.0/3.11/2.17');
    expect(result.plan.presentation?.rejectedCandidateSummaries?.[0]).toContain(detail);
    expect(result.rejectedCandidates[0]?.reason).toContain(detail);
    const warnings = formatPythonPlanningWarnings(result, '/report/environment-plan.json').join(
      '\n'
    );
    expect(warnings).toContain('selected 1.0.0; rejected 1 newer version(s), newest 2.0.0');
    expect(warnings).toContain('native-dep has no usable wheels');
    expect(warnings).toContain('skipped requested Python 3.12');
    expect(warnings).toContain('/report/environment-plan.json');
    expect(
      formatPythonPlanningWarnings(
        {
          plan: { ...result.plan, presentation: { skippedPythonMinors: [] } },
          rejectedCandidates: [],
        },
        '/report'
      )
    ).toEqual([]);
    const longWarnings = formatPythonPlanningWarnings(
      {
        ...result,
        rejectedCandidates: [
          { applicationVersion: '2.0.0', pythonMinor: '3.11', reason: 'x'.repeat(5000) },
        ],
      },
      '/report'
    );
    expect(longWarnings[1]!.length).toBeLessThan(550);
  });

  it('does not treat a planner tool failure as Python incompatibility', async () => {
    const resolver: PythonApplicationResolver = {
      resolve: () =>
        Promise.reject(new UvResolutionError('tool-failure', 'pinned uv could not start')),
    };
    await expect(
      planPythonApplication({
        cacheDir: '/cache',
        coveragePolicy: normalizePlatformCoveragePolicy({
          id: 'desktop-x64',
          platforms: ['linux-glibc-x86_64'],
        }),
        createdAt: '2026-07-27T00:00:00.000Z',
        index: new FixtureIndex(),
        intent: {
          ...intent,
          application: { ...intent.application, version: '==1.0.0' },
          python: { policy: 'selected', versions: ['3.11', '3.12'] },
        },
        plannerPolicy,
        resolver,
        uvPath: '/tools/uv',
        workDir: '/work',
      })
    ).rejects.toMatchObject({ kind: 'tool-failure' });
  });
});
