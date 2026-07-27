import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PythonApplicationPlanningError,
  planPythonApplication,
  type PythonPlannerPolicy,
} from '../../src/core/python/application-planner.js';
import {
  normalizePythonApplicationRecipe,
  resolvePythonApplicationRecipe,
  type PythonApplicationRecipe,
} from '../../src/core/python/application-recipe.js';
import { createPythonConsumerBundleDocuments } from '../../src/core/python/consumer-contract.js';
import { normalizePlatformCoveragePolicy } from '../../src/core/python/coverage-policy.js';
import type {
  PythonIndexClient,
  PythonIndexFile,
  PythonProjectIndex,
} from '../../src/core/python/index-client.js';
import { addPythonRuntimeContract } from '../../src/core/python/runtime-contract.js';
import type {
  PythonApplicationResolver,
  UvResolveRequest,
  UvResolutionEvidence,
} from '../../src/core/python/uv-adapter.js';

const fixturePath = path.resolve('test/fixtures/python/ktransformers-0.6.1.post1-provenance.json');
const recipePath = path.resolve('support/python/recipes/ktransformers-0.6.1.post1.json');

interface ProvenanceFixture {
  projects: Record<
    string,
    {
      files: {
        filename: string;
        sha256: string;
        size: number;
      }[];
      version: string;
    }
  >;
}

let fixture: ProvenanceFixture;
let recipe: PythonApplicationRecipe;

beforeAll(async () => {
  fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as ProvenanceFixture;
  recipe = normalizePythonApplicationRecipe(JSON.parse(await readFile(recipePath, 'utf8')));
});

function project(name: string): PythonProjectIndex {
  const captured = fixture.projects[name];
  if (!captured) {
    throw new Error(`Missing KTransformers fixture project: ${name}`);
  }
  return {
    apiVersion: '1.0',
    files: captured.files.map<PythonIndexFile>((file) => ({
      filename: file.filename,
      hashes: {
        sha256: file.sha256,
      },
      size: file.size,
      url: `https://files.pythonhosted.org/fixture/${file.filename}`,
    })),
    name,
  };
}

class KTransformersIndex implements PythonIndexClient {
  readonly sourceIndex = 'https://pypi.org/simple/';

  getMetadata(): Promise<never> {
    return Promise.reject(new Error('metadata is not needed by this captured fixture'));
  }

  getProject(name: string): Promise<PythonProjectIndex> {
    return Promise.resolve(project(name));
  }
}

function lockEvidence(request: UvResolveRequest): UvResolutionEvidence {
  return {
    content: `captured KTransformers lock for ${request.platformFamilyId} ${request.pythonMinor}`,
    digest: 'd'.repeat(64),
    lock: {
      createdBy: 'uv 0.11.16',
      defaultGroups: [],
      dependencyGroups: [],
      environments: [],
      extras: [],
      format: 'pylock',
      packages: [
        {
          dependencies: [{ name: 'kt-kernel' }],
          devDependencies: {},
          name: 'ktransformers',
          optionalDependencies: {},
          sourceKind: 'registry',
          version: '0.6.1.post1',
          wheels: [],
        },
        {
          dependencies: [],
          devDependencies: {},
          name: 'kt-kernel',
          optionalDependencies: {},
          sourceKind: 'registry',
          version: '0.6.1.post1',
          wheels: [],
        },
      ],
      sourcePath: 'captured-ktransformers.pylock.toml',
      version: '1.0',
    },
    platformTarget: request.platformFamilyId,
  };
}

class KTransformersResolver implements PythonApplicationResolver {
  readonly requests: UvResolveRequest[] = [];

  resolve(request: UvResolveRequest): Promise<UvResolutionEvidence> {
    this.requests.push(request);
    return Promise.resolve(lockEvidence(request));
  }
}

const intent = {
  application: {
    extras: [],
    features: {
      accelerator: 'cuda',
    },
    name: 'ktransformers',
    recipe: 'support/python/recipes/ktransformers-0.6.1.post1.json',
    version: '==0.6.1.post1',
  },
  coverage: {
    policyId: 'desktop-x64',
  },
  python: {
    policy: 'auto' as const,
  },
  source: {
    indexUrl: 'https://pypi.org/simple/',
    type: 'pypi' as const,
  },
  updatePolicy: 'manual' as const,
};

const plannerPolicy: PythonPlannerPolicy = {
  glibcBaselines: ['2.28', '2.35'],
  pythonMinors: ['3.11', '3.12'],
  version: 1,
};

describe('KTransformers vertical slice', () => {
  it('loads the maintained recipe and keeps accelerator selection explicit', () => {
    expect(recipe).toMatchObject({
      application: 'ktransformers',
      compatibility: {
        applicationVersions: '==0.6.1.post1',
        preferredPythonMinors: ['3.11', '3.12'],
      },
      id: 'ktransformers-0.6.1.post1',
    });
    expect(resolvePythonApplicationRecipe(recipe, intent)).toEqual({
      additionalRequirements: [],
      extras: [],
    });
    expect(() =>
      resolvePythonApplicationRecipe(recipe, {
        ...intent,
        application: {
          ...intent.application,
          features: {
            accelerator: 'detected-from-gpu',
          },
        },
      })
    ).toThrow('does not support detected-from-gpu');
  });

  it('rejects broad Windows/Linux coverage with the reviewed upstream boundary', async () => {
    const resolver = new KTransformersResolver();
    const planning = planPythonApplication({
      cacheDir: '/cache',
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
      }),
      createdAt: '2026-07-27T00:00:00.000Z',
      cutoff: '2026-07-27T00:00:00.000Z',
      index: new KTransformersIndex(),
      intent,
      plannerPolicy,
      recipe,
      resolver,
      uvPath: '/tools/uv',
      workDir: '/work',
    });

    try {
      await planning;
      expect.fail('broad KTransformers coverage should be rejected');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PythonApplicationPlanningError);
      if (!(error instanceof PythonApplicationPlanningError)) {
        throw error;
      }
      expect(
        error.rejectedCandidates.some(
          (candidate) =>
            candidate.platformFamilyId === 'windows-x86_64' &&
            candidate.reason.includes('no Windows wheel')
        )
      ).toBe(true);
    }
    expect(resolver.requests).toEqual([]);
  });

  it('creates a complete Linux plan, runtime contract, and exact consumer lock', async () => {
    const resolver = new KTransformersResolver();
    const result = await planPythonApplication({
      cacheDir: '/cache',
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'ktransformers-linux-x64',
        platforms: ['linux-glibc-x86_64'],
      }),
      createdAt: '2026-07-27T00:00:00.000Z',
      cutoff: '2026-07-27T00:00:00.000Z',
      index: new KTransformersIndex(),
      intent: {
        ...intent,
        coverage: {
          policyId: 'ktransformers-linux-x64',
        },
      },
      plannerPolicy,
      recipe,
      resolver,
      uvPath: '/tools/uv',
      workDir: '/work',
    });
    const plan = addPythonRuntimeContract(result.plan, {
      applicationArtifactOwner: 'python-apps',
      pythonPackageOwner: 'pypi',
      recipe,
    });
    const consumer = createPythonConsumerBundleDocuments(plan, {
      giteaBaseUrl: 'http://gitea.local:3000',
    });

    expect(plan.preferredPythonMinor).toBe('3.11');
    expect(plan.recipe).toMatchObject({
      id: 'ktransformers-0.6.1.post1',
      version: '2026-07-27',
    });
    expect(plan.recipe?.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.platforms).toEqual([
      expect.objectContaining({
        platformFamilyId: 'linux-glibc-x86_64',
        status: 'supported',
        supportBoundary: {
          glibc: '2.35',
        },
      }),
    ]);
    expect(plan.wheels.map((wheel) => wheel.filename)).toEqual([
      'kt_kernel-0.6.1.post1-cp311-cp311-manylinux_2_35_x86_64.whl',
      'ktransformers-0.6.1.post1-py3-none-any.whl',
    ]);
    expect(plan.runtimeContract?.platforms[0]).toMatchObject({
      provisionedExternally: true,
      pythonMinor: '3.11',
      systemPrerequisites: ['glibc >= 2.35', 'Linux x86-64', 'x86-64 CPU with AVX2'],
    });
    expect(consumer.locks[0]?.content).toContain('ktransformers==0.6.1.post1');
    expect(consumer.locks[0]?.content).toContain('kt-kernel==0.6.1.post1');
    expect(consumer.contract.platforms[0]?.install.pip).toEqual(
      expect.arrayContaining(['--only-binary=:all:', '--no-deps', '--require-hashes'])
    );
    expect(consumer.contract.platforms[0]?.healthChecks).toEqual([
      {
        args: ['-c', 'import ktransformers'],
        command: 'python',
      },
    ]);
    expect(resolver.requests.map((request) => request.glibc)).toEqual(['2.28', '2.35']);
  });
});
