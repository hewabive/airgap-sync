import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { semanticDigest } from '../../src/core/canonical-json.js';
import * as fs from '../../src/core/fs.js';
import type { ActivePythonApplicationPlan } from '../../src/core/python/active-plan-store.js';
import type { PythonApplicationRecipe } from '../../src/core/python/application-recipe.js';
import type { PythonApplicationVersionSelector } from '../../src/core/python/application-intent.js';
import {
  pythonApplicationSelectorId,
  pythonApplicationVariantId,
} from '../../src/core/python/application-paths.js';
import { platformCoveragePolicyDigest } from '../../src/core/python/coverage-policy.js';
import { createPythonEnvironmentPlan } from '../../src/core/python/environment-plan.js';
import { ensureWorkspacePythonApplicationPlans } from '../../src/core/python/workspace-plan-preflight.js';
import {
  initWorkspace,
  pythonApplicationIntentForVersionSelector,
  resolveWorkspacePythonApplication,
  type WorkspaceConfig,
  type WorkspacePythonApplicationTarget,
} from '../../src/core/workspace.js';

let workspaceDir: string;
let config: WorkspaceConfig;

function applicationTarget(spec = 'demo'): WorkspacePythonApplicationTarget {
  return {
    application: {
      extras: [],
      features: {},
    },
    coverage: 'desktop-x64',
    python: {
      policy: 'auto',
    },
    spec,
    type: 'python-app',
  };
}

function activePlanFor(
  workspaceConfig: WorkspaceConfig,
  target: WorkspacePythonApplicationTarget,
  recipe?: PythonApplicationRecipe,
  selector?: PythonApplicationVersionSelector,
  applicationVersion = '1.0.0'
): ActivePythonApplicationPlan {
  const resolved = resolveWorkspacePythonApplication(workspaceConfig, target);
  const selected = selector ?? resolved.versionSelection.selectors[0]!;
  const plan = createPythonEnvironmentPlan({
    application: {
      name: resolved.intent.application.name,
      version: applicationVersion,
    },
    coverage: {
      digest: platformCoveragePolicyDigest(resolved.coveragePolicy),
      families: [],
      policy: resolved.coveragePolicy,
    },
    createdAt: '2026-07-27T00:00:00.000Z',
    intent: pythonApplicationIntentForVersionSelector(resolved, selected),
    platforms: [],
    ...(recipe
      ? {
          recipe: {
            digest: semanticDigest(recipe),
            id: recipe.id,
            version: recipe.version,
          },
        }
      : {}),
    resolver: {
      engine: 'uv',
      policyVersion: 1,
      version: '0.11.16',
    },
    runtimeContract: {
      platforms: [],
    },
    schemaVersion: 2,
    wheels: [],
  });
  return { plan } as ActivePythonApplicationPlan;
}

describe('workspace Python application plan preflight', () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-plan-preflight-'));
    config = await initWorkspace({ workspaceDir });
    config.targets = [applicationTarget()];
  });

  afterEach(async () => {
    await fs.remove(workspaceDir);
  });

  it('creates a missing plan before returning it', async () => {
    let stored: ActivePythonApplicationPlan | undefined;
    const planned: number[][] = [];

    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      planTargets: (indexes) => {
        planned.push(indexes);
        stored = activePlanFor(config, config.targets[0] as WorkspacePythonApplicationTarget);
        return Promise.resolve();
      },
      readActivePlan: () => {
        if (!stored) {
          return Promise.reject(new Error('missing'));
        }
        return Promise.resolve(stored);
      },
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });

    expect(planned).toEqual([[1]]);
    expect(result.plannedTargetIndexes).toEqual([1]);
    expect(result.targets).toMatchObject([
      { targetId: 'demo--desktop-x64--version-1.0.0', targetIndex: 1 },
    ]);
  });

  it('reuses a current plan without invoking the planner', async () => {
    const stored = activePlanFor(config, config.targets[0] as WorkspacePythonApplicationTarget);
    let plannerCalled = false;

    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      planTargets: () => {
        plannerCalled = true;
        return Promise.resolve();
      },
      readActivePlan: () => Promise.resolve(stored),
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });

    expect(plannerCalled).toBe(false);
    expect(result.plannedTargetIndexes).toEqual([]);
    expect(result.targets[0]?.activePlan).toBe(stored);
  });

  it('replans when application intent changed', async () => {
    const target = config.targets[0] as WorkspacePythonApplicationTarget;
    let stored = activePlanFor(config, target);
    target.application.extras = ['server'];

    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      planTargets: (indexes) => {
        expect(indexes).toEqual([1]);
        stored = activePlanFor(config, target);
        return Promise.resolve();
      },
      readActivePlan: () => Promise.resolve(stored),
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });

    expect(result.plannedTargetIndexes).toEqual([1]);
    expect(result.targets[0]?.activePlan.plan.intent.application.extras).toEqual(['server']);
  });

  it('keeps a current plan when publication coordinates changed', async () => {
    const target = config.targets[0] as WorkspacePythonApplicationTarget;
    const stored = activePlanFor(config, target);
    config.python!.publication = {
      owner: {
        kind: 'organization',
        name: 'other-python-packages',
        strategy: 'fixed-owner',
      },
      visibility: 'public',
    };

    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      planTargets: () => Promise.reject(new Error('planner must not run')),
      readActivePlan: () => Promise.resolve(stored),
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });

    expect(result.plannedTargetIndexes).toEqual([]);
    expect(result.targets[0]?.activePlan.plan.planId).toBe(stored.plan.planId);
  });

  it('replans when a workspace recipe changed', async () => {
    const target = config.targets[0] as WorkspacePythonApplicationTarget;
    target.application.recipe = '.airgap-sync/recipes/demo.json';
    let recipe: PythonApplicationRecipe = {
      application: 'demo',
      id: 'demo',
      schemaVersion: 1,
      version: '1',
    };
    let stored = activePlanFor(config, target, recipe);
    recipe = { ...recipe, version: '2' };

    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      planTargets: () => {
        stored = activePlanFor(config, target, recipe);
        return Promise.resolve();
      },
      readActivePlan: () => Promise.resolve(stored),
      readRecipe: () => Promise.resolve(recipe),
      workspaceDir,
    });

    expect(result.plannedTargetIndexes).toEqual([1]);
    expect(result.targets[0]?.activePlan.plan.recipe?.version).toBe('2');
  });

  it('plans only selected workspace target indexes', async () => {
    config.targets = [applicationTarget('first'), applicationTarget('second')];
    let stored: ActivePythonApplicationPlan | undefined;

    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      planTargets: (indexes) => {
        expect(indexes).toEqual([2]);
        stored = activePlanFor(config, config.targets[1] as WorkspacePythonApplicationTarget);
        return Promise.resolve();
      },
      readActivePlan: () => {
        if (!stored) {
          return Promise.reject(new Error('missing'));
        }
        return Promise.resolve(stored);
      },
      readRecipe: () => Promise.resolve(undefined),
      targetIndexes: [2],
      workspaceDir,
    });

    expect(result.plannedTargetIndexes).toEqual([2]);
    expect(result.targets).toMatchObject([
      { targetId: 'second--desktop-x64--version-1.0.0', targetIndex: 2 },
    ]);
  });

  it('requires every exact/latest selector and deduplicates the resolved variant', async () => {
    const target = config.targets[0] as WorkspacePythonApplicationTarget;
    target.application.versionSelection = {
      selectors: [{ type: 'exact', version: '0.25.1' }, { type: 'latest-compatible' }],
    };
    const resolved = resolveWorkspacePythonApplication(config, target);
    const stored = new Map<string, ActivePythonApplicationPlan>();

    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      planTargets: (indexes) => {
        expect(indexes).toEqual([1]);
        for (const selector of resolved.versionSelection.selectors) {
          stored.set(
            pythonApplicationSelectorId(
              resolved.intent.application.name,
              resolved.coveragePolicy.id,
              selector
            ),
            activePlanFor(config, target, undefined, selector, '0.25.1')
          );
        }
        return Promise.resolve();
      },
      readActivePlan: (_workspace, targetId) => {
        const plan = stored.get(targetId);
        return plan ? Promise.resolve(plan) : Promise.reject(new Error('missing'));
      },
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });

    expect(result.plannedTargetIndexes).toEqual([1]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      selector: { type: 'exact', version: '0.25.1' },
      selectionId: 'demo--desktop-x64',
      targetId: pythonApplicationVariantId('demo', '0.25.1', 'desktop-x64'),
    });
  });

  it('fails if planning does not produce a current plan', async () => {
    await expect(
      ensureWorkspacePythonApplicationPlans({
        config,
        planTargets: () => Promise.resolve(),
        readActivePlan: () => Promise.reject(new Error('still missing')),
        readRecipe: () => Promise.resolve(undefined),
        workspaceDir,
      })
    ).rejects.toThrow('Planning did not create a usable active plan');
  });
});
