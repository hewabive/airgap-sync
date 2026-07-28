import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as fs from '../../src/core/fs.js';
import {
  createPythonEnvironmentPlan,
  type PythonEnvironmentPlan,
} from '../../src/core/python/environment-plan.js';
import {
  compareMachineToPythonEnvironmentPlan,
  normalizeMachineProbeFacts,
  probeMachine,
  type MachineProbeFacts,
} from '../../src/core/python/probe.js';
import {
  normalizePlatformCoveragePolicy,
  platformCoveragePolicyDigest,
} from '../../src/core/python/coverage-policy.js';

const fixtureDirectory = path.resolve('test/fixtures/python/probe');

async function readFacts(name: string): Promise<MachineProbeFacts> {
  return fs.readJson<MachineProbeFacts>(path.join(fixtureDirectory, name));
}

function environmentPlan(): PythonEnvironmentPlan {
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
          glibc: '2.35',
        },
      },
    ],
    resolver: {
      engine: 'uv',
      policyVersion: 1,
      version: '0.11.16',
    },
    schemaVersion: 2,
    wheels: [],
  });
}

describe('optional platform probe', () => {
  it.each([
    ['windows-x86_64.json', 'compatible'],
    ['linux-glibc-2.35.json', 'compatible'],
    ['linux-glibc-unknown-distribution.json', 'compatible'],
    ['linux-glibc-2.28.json', 'incompatible'],
    ['linux-musl.json', 'incompatible'],
    ['linux-without-python.json', 'needs-action'],
  ] as const)('compares %s without requiring a distro catalog match', async (fixture, status) => {
    const comparison = compareMachineToPythonEnvironmentPlan(
      await readFacts(fixture),
      environmentPlan()
    );
    expect(comparison.status).toBe(status);
  });

  it('collects only plan-relevant Linux facts', async () => {
    const commandRunner = vi.fn((command: string) => {
      if (command === 'python3') {
        return Promise.resolve({
          stderr: '',
          stdout: 'Python 3.11.9\n',
        });
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
    const facts = await probeMachine({
      commandRunner,
      nodeArch: 'x64',
      nodePlatform: 'linux',
      report: {
        header: {
          glibcVersionRuntime: '2.39',
        },
      },
    });

    expect(facts).toEqual({
      architecture: 'x86_64',
      capabilities: {},
      libc: {
        family: 'glibc',
        version: '2.39',
      },
      os: 'linux',
      python: {
        command: 'python3',
        version: '3.11.9',
      },
    });
    expect(facts).not.toHaveProperty('hostname');
    expect(facts).not.toHaveProperty('network');
    expect(facts).not.toHaveProperty('distribution');
  });

  it('normalizes standalone facts and drops unrelated machine data', async () => {
    const facts = await readFacts('linux-glibc-unknown-distribution.json');
    expect(
      normalizeMachineProbeFacts({
        ...facts,
        hostname: 'must-not-survive',
        network: ['must-not-survive'],
      })
    ).toEqual(facts);
  });

  it('requires explicitly declared application capabilities', async () => {
    const plan = environmentPlan();
    plan.intent.application.features = {
      accelerator: 'cuda-12',
    };
    const facts = await readFacts('windows-x86_64.json');

    expect(compareMachineToPythonEnvironmentPlan(facts, plan).status).toBe('needs-action');
    expect(
      compareMachineToPythonEnvironmentPlan(
        {
          ...facts,
          capabilities: {
            accelerator: 'cuda-12',
          },
        },
        plan
      ).status
    ).toBe('compatible');
  });
});
