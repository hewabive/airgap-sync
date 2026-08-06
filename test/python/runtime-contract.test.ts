import { describe, expect, it } from 'vitest';
import {
  addPythonRuntimeContract,
  createPythonPrerequisiteReport,
} from '../../src/core/python/runtime-contract.js';
import {
  createPythonEnvironmentPlan,
  type PythonEnvironmentPlan,
} from '../../src/core/python/environment-plan.js';
import { normalizePlatformCoveragePolicy } from '../../src/core/python/coverage-policy.js';

function plan(): PythonEnvironmentPlan {
  const policy = normalizePlatformCoveragePolicy({
    id: 'desktop-x64',
    platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
  });
  return createPythonEnvironmentPlan({
    application: {
      name: 'demo-app',
      version: '1.0.0',
    },
    coverage: {
      digest: 'a'.repeat(64),
      families: [
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
      ],
      policy,
    },
    createdAt: '2026-07-27T00:00:00.000Z',
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
      {
        packages: [],
        platformFamilyId: 'linux-glibc-x86_64',
        pythonMinor: '3.11',
        rejectedReasons: [],
        requiresPython: '>=3.11,<3.12',
        status: 'supported',
        supportBoundary: {
          glibc: '2.28',
        },
      },
    ],
    preferredPythonMinor: '3.11',
    resolver: {
      engine: 'uv',
      policyVersion: 1,
      version: '0.11.16',
    },
    schemaVersion: 2,
    wheels: [],
  });
}

describe('Python runtime contract', () => {
  it('declares external provisioning and machine prerequisites', () => {
    const original = plan();
    const enriched = addPythonRuntimeContract(original, {
      recipe: {
        application: 'demo-app',
        healthChecks: [{ args: ['-c', 'import demo_app'], command: 'python' }],
        id: 'demo',
        schemaVersion: 1,
        systemPrerequisites: ['libdemo >= 1'],
        version: '1',
      },
    });

    expect(enriched.planId).not.toBe(original.planId);
    expect(enriched.runtimeContract?.platforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platformFamilyId: 'windows-x86_64',
          provisionedExternally: true,
          systemPrerequisites: ['libdemo >= 1'],
        }),
        expect.objectContaining({
          platformFamilyId: 'linux-glibc-x86_64',
          provisionedExternally: true,
          systemPrerequisites: ['glibc >= 2.28', 'libdemo >= 1'],
        }),
      ])
    );
    expect(enriched).not.toHaveProperty('installActions');
    expect(enriched).toMatchObject({
      verification: {
        healthChecks: [{ args: ['-c', 'import demo_app'], command: 'python' }],
      },
    });
    expect(createPythonPrerequisiteReport(enriched, '2026-07-27T00:00:00.000Z')).toMatchObject({
      application: {
        name: 'demo-app',
      },
      generatedAt: '2026-07-27T00:00:00.000Z',
      installationOwner: 'consumer-infrastructure',
      planId: enriched.planId,
    });
  });

  it('rejects obsolete runtime transfer fields when reading stored plans', () => {
    expect(() =>
      createPythonEnvironmentPlan({
        ...plan(),
        runtimeArtifacts: [],
      } as Parameters<typeof createPythonEnvironmentPlan>[0])
    ).toThrow('runtime transfer fields are obsolete');
  });
});
