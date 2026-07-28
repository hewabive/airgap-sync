import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { semanticDigest } from '../../src/core/canonical-json.js';
import * as fs from '../../src/core/fs.js';
import {
  readActivePythonApplicationPlan,
  writeActivePythonApplicationPlan,
} from '../../src/core/python/active-plan-store.js';
import { normalizePlatformCoveragePolicy } from '../../src/core/python/coverage-policy.js';
import { createPythonEnvironmentPlan } from '../../src/core/python/environment-plan.js';

let workspaceDir: string;

describe('active Python application plan store', () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-active-plan-'));
  });

  afterEach(async () => {
    await fs.remove(workspaceDir);
  });

  it('persists an immutable plan, raw resolver evidence, and a plan diff', async () => {
    const content = [
      'lock-version = "1.0"',
      'created-by = "uv 0.11.16"',
      '',
      '[[packages]]',
      'name = "demo"',
      'version = "1.0.0"',
      'wheels = []',
      '',
    ].join('\n');
    const plan = createPythonEnvironmentPlan({
      application: { name: 'demo', version: '1.0.0' },
      coverage: {
        digest: 'a'.repeat(64),
        families: [],
        policy: normalizePlatformCoveragePolicy({
          id: 'windows',
          platforms: ['windows-x86_64'],
        }),
      },
      createdAt: '2026-07-27T00:00:00.000Z',
      intent: {
        application: { extras: [], features: {}, name: 'demo' },
        coverage: { policyId: 'windows' },
        python: { policy: 'auto' },
        source: { type: 'pypi' },
        updatePolicy: 'manual',
      },
      platforms: [
        {
          packages: [],
          platformFamilyId: 'windows-x86_64',
          pylockPath: 'lock/windows-x86_64--py311.pylock.toml',
          pythonMinor: '3.11',
          rejectedReasons: [],
          requirementsLockPath: 'lock/windows-x86_64--py311.requirements.lock',
          requiresPython: '>=3.11,<3.12',
          status: 'supported',
        },
      ],
      resolver: { engine: 'uv', policyVersion: 1, version: '0.11.16' },
      schemaVersion: 2,
      wheels: [],
    });

    const written = await writeActivePythonApplicationPlan({
      evidence: [
        {
          platformFamilyId: 'windows-x86_64',
          pylock: {
            content,
            digest: semanticDigest(content),
            lock: {
              createdBy: 'uv 0.11.16',
              defaultGroups: [],
              dependencyGroups: [],
              environments: [],
              extras: [],
              format: 'pylock',
              packages: [],
              sourcePath: 'fixture',
              version: '1.0',
            },
            platformTarget: 'x86_64-pc-windows-msvc',
          },
          pythonMinor: '3.11',
        },
      ],
      plan,
      targetIndex: 1,
      workspaceDir,
    });

    expect(written.diff).toMatchObject({ changed: true, planId: { to: plan.planId } });
    const stored = await readActivePythonApplicationPlan(workspaceDir, written.manifest.targetId);
    expect(stored.plan).toEqual(plan);
    expect(stored.evidence[0]?.pylock.content).toBe(content);
    expect(stored.diff.planId.to).toBe(plan.planId);
  });
});
