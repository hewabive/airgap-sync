import { describe, expect, it } from 'vitest';
import { canonicalJson, semanticDigest } from '../../src/core/canonical-json.js';
import {
  pythonApplicationPlanDirectory,
  pythonApplicationPlanPath,
  pythonApplicationTargetId,
} from '../../src/core/python/application-paths.js';
import {
  normalizePlatformCoveragePolicy,
  platformCoveragePolicyDigest,
} from '../../src/core/python/coverage-policy.js';
import {
  createPythonEnvironmentPlan,
  pythonEnvironmentPlanId,
  serializePythonEnvironmentPlan,
  type PythonEnvironmentPlanInput,
} from '../../src/core/python/environment-plan.js';

function planInput(createdAt: string): PythonEnvironmentPlanInput {
  const policy = normalizePlatformCoveragePolicy({
    id: 'desktop-x64',
    platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
  });
  return {
    application: {
      name: 'demo-app',
      version: '1.2.3',
    },
    coverage: {
      digest: platformCoveragePolicyDigest(policy),
      families: [
        {
          architecture: 'x86_64',
          definitionVersion: 1,
          id: 'windows-x86_64',
          os: 'windows',
          status: 'supported',
          wheelPlatformFamilies: ['win_amd64'],
        },
      ],
      policy,
    },
    createdAt,
    intent: {
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
    },
    platforms: [
      {
        packages: [],
        platformFamilyId: 'windows-x86_64',
        pythonMinor: '3.11',
        rejectedReasons: [],
        requiresPython: '>=3.11,<3.12',
        status: 'supported',
      },
    ],
    resolver: {
      engine: 'uv',
      policyVersion: 1,
      version: '0.11.16',
    },
    schemaVersion: 2,
    wheels: [],
  };
}

describe('Python application domain', () => {
  it('serializes JSON canonically and hashes semantic content', () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: undefined }, list: [1, undefined] })).toBe(
      '{"a":{"y":true},"list":[1,null],"z":1}'
    );
    expect(semanticDigest({ b: 2, a: 1 })).toBe(semanticDigest({ a: 1, b: 2 }));
  });

  it('normalizes and hashes coverage independently from its display id', () => {
    const first = normalizePlatformCoveragePolicy({
      id: 'desktop-x64',
      linux: {
        oldestSupportedGlibc: '2.28',
      },
      platforms: ['linux-glibc-x86_64', 'windows-x86_64'],
    });
    const renamed = {
      ...first,
      id: 'office-x64',
    };

    expect(first).toEqual({
      id: 'desktop-x64',
      linux: {
        oldestSupportedGlibc: '2.28',
      },
      platforms: ['linux-glibc-x86_64', 'windows-x86_64'],
      version: 1,
      wheelStrategy: 'minimum-cover',
    });
    expect(platformCoveragePolicyDigest(first)).toBe(platformCoveragePolicyDigest(renamed));
  });

  it('creates stable application plan paths', () => {
    const targetId = pythonApplicationTargetId('Demo_App', 'Desktop X64');
    expect(targetId).toBe('demo-app--desktop-x64');
    expect(pythonApplicationPlanDirectory(targetId)).toBe(
      'python/applications/demo-app--desktop-x64'
    );
    expect(pythonApplicationPlanPath(targetId)).toBe(
      'python/applications/demo-app--desktop-x64/environment-plan.json'
    );
  });

  it('excludes timestamps and presentation text from plan identity', () => {
    const first = {
      ...planInput('2026-07-27T00:00:00.000Z'),
      presentation: {
        warnings: ['first wording'],
      },
    };
    const second = {
      ...planInput('2027-01-01T00:00:00.000Z'),
      presentation: {
        warnings: ['reworded'],
      },
    };

    expect(pythonEnvironmentPlanId(first)).toBe(pythonEnvironmentPlanId(second));
    expect(createPythonEnvironmentPlan(first).planId).toBe(
      createPythonEnvironmentPlan(second).planId
    );
  });

  it('round-trips a plan through canonical JSON without changing its identity', () => {
    const plan = createPythonEnvironmentPlan(planInput('2026-07-27T00:00:00.000Z'));
    const roundTripped = createPythonEnvironmentPlan(
      JSON.parse(serializePythonEnvironmentPlan(plan)) as PythonEnvironmentPlanInput
    );

    expect(roundTripped).toEqual(plan);
    expect(serializePythonEnvironmentPlan(roundTripped)).toBe(serializePythonEnvironmentPlan(plan));
  });

  it('rejects a supplied plan id that does not match semantic content', () => {
    expect(() =>
      createPythonEnvironmentPlan({
        ...planInput('2026-07-27T00:00:00.000Z'),
        planId: '0'.repeat(64),
      })
    ).toThrow('plan ID mismatch');
  });
});
