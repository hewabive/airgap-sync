import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { PythonIndexClient, PythonIndexFile } from '../../src/core/python/index-client.js';
import { parseRequirement } from '../../src/core/python/requirements.js';
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

function applicationFile(version = '1.0.0', name = 'demo'): PythonIndexFile {
  const filename = `${name.replaceAll('-', '_')}-${version}-py3-none-any.whl`;
  return {
    filename,
    hashes: { sha256: 'a'.repeat(64) },
    uploadTime: '2026-07-01T00:00:00.000Z',
    url: `https://example.test/${filename}`,
  };
}

function fixtureIndex(files: PythonIndexFile[]) {
  return {
    sourceIndex: 'https://example.test/simple/',
    getMetadata: () => Promise.reject(new Error('metadata must not be fetched')),
    getProject: vi.fn((name: string) => Promise.resolve({ apiVersion: '1.0', files, name })),
  } satisfies PythonIndexClient;
}

function applicationTarget(spec = 'demo'): WorkspacePythonApplicationTarget {
  const parsed = parseRequirement(spec);
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    application: {
      extras: [],
      features: {},
      ...(parsed.requirement.specifier ? { version: parsed.requirement.specifier } : {}),
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
  const file = applicationFile(applicationVersion, resolved.intent.application.name);
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
    wheels: [
      {
        filename: file.filename,
        package: resolved.intent.application.name,
        platforms: [],
        sha256: file.hashes.sha256!,
        url: file.url,
        version: applicationVersion,
      },
    ],
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

  it('reuses a current exact plan without invoking the planner', async () => {
    config.targets = [
      {
        ...applicationTarget(),
        application: {
          extras: [],
          features: {},
          versionSelection: { selectors: [{ type: 'exact', version: '1.0.0' }] },
        },
      },
    ];
    const stored = activePlanFor(config, config.targets[0] as WorkspacePythonApplicationTarget);
    let plannerCalled = false;

    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      createIndexClient: () => {
        throw new Error('index must not be queried');
      },
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

  it.each(['demo', 'demo>=1'])('refreshes a current moving selector %s', async (spec) => {
    const target = applicationTarget(spec);
    config.targets = [target];
    let stored = activePlanFor(config, target);
    const reasons: string[] = [];
    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      createIndexClient: () => fixtureIndex([applicationFile(), applicationFile('2.0.0')]),
      onPlanRequired: (requirements) => reasons.push(...requirements.map((item) => item.reason)),
      planTargets: () => {
        stored = activePlanFor(config, target, undefined, undefined, '2.0.0');
        return Promise.resolve();
      },
      readActivePlan: () => Promise.resolve(stored),
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });
    expect(reasons).toEqual(['refresh-latest']);
    expect(result.plannedTargetIndexes).toEqual([1]);
    expect(result.targets[0]?.activePlan.plan.application.version).toBe('2.0.0');
  });

  it.each(['demo', 'demo>=1', 'demo<2'])(
    'reuses the latest plan for %s without resolving dependencies',
    async (spec) => {
      const target = applicationTarget(spec);
      config.targets = [target];
      const stored = activePlanFor(config, target);
      const index = fixtureIndex([
        applicationFile(),
        applicationFile('2.0.0rc1'),
        { ...applicationFile('3.0.0'), yanked: true },
        { ...applicationFile('4.0.0'), uploadTime: '2027-01-01T00:00:00.000Z' },
        applicationFile('5.0.0', 'other'),
        { ...applicationFile('6.0.0'), filename: 'demo-6.0.0.tar.gz' },
        ...(spec === 'demo<2' ? [applicationFile('2.0.0')] : []),
      ]);
      const result = await ensureWorkspacePythonApplicationPlans({
        config,
        createIndexClient: () => index,
        cutoff: '2026-09-08T00:00:00.000Z',
        planTargets: () => Promise.reject(new Error('planner must not run')),
        readActivePlan: () => Promise.resolve(stored),
        readRecipe: () => Promise.resolve(undefined),
        workspaceDir,
      });
      expect(index.getProject).toHaveBeenCalledExactlyOnceWith('demo');
      expect(result.plannedTargetIndexes).toEqual([]);
      expect(result.targets[0]?.activePlan).toBe(stored);
    }
  );

  it('still resolves newer candidates when an earlier attempt found them incompatible', async () => {
    const target = config.targets[0] as WorkspacePythonApplicationTarget;
    const stored = activePlanFor(config, target);
    stored.plan.presentation = { rejectedCandidateSummaries: ['2.0.0 has no compatible wheels'] };
    const planTargets = vi.fn(() => Promise.resolve());
    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      createIndexClient: () => fixtureIndex([applicationFile(), applicationFile('2.0.0')]),
      planTargets,
      readActivePlan: () => Promise.resolve(stored),
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });
    expect(planTargets).toHaveBeenCalledExactlyOnceWith([1]);
    expect(result.targets[0]?.activePlan.plan.application.version).toBe('1.0.0');
  });

  it.each(['removed', 'yanked', 'changed hash'])(
    'replans when a planned application wheel is %s even if the version remains available',
    async (change) => {
      const target = config.targets[0] as WorkspacePythonApplicationTarget;
      const stored = activePlanFor(config, target);
      const files = [
        { ...applicationFile(), filename: 'demo-1.0.0-cp312-cp312-win_amd64.whl' },
        ...(change === 'removed'
          ? []
          : [
              {
                ...applicationFile(),
                ...(change === 'yanked' ? { yanked: true as const } : {}),
                ...(change === 'changed hash' ? { hashes: { sha256: 'b'.repeat(64) } } : {}),
              },
            ]),
      ];
      const planTargets = vi.fn(() => Promise.resolve());
      await ensureWorkspacePythonApplicationPlans({
        config,
        createIndexClient: () => fixtureIndex(files),
        planTargets,
        readActivePlan: () => Promise.resolve(stored),
        readRecipe: () => Promise.resolve(undefined),
        workspaceDir,
      });
      expect(planTargets).toHaveBeenCalledExactlyOnceWith([1]);
    }
  );

  it('replans when the selected release disappears from the index', async () => {
    const target = config.targets[0] as WorkspacePythonApplicationTarget;
    let stored = activePlanFor(config, target);
    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      createIndexClient: () => fixtureIndex([applicationFile('0.9.0')]),
      planTargets: () => {
        stored = activePlanFor(config, target, undefined, undefined, '0.9.0');
        return Promise.resolve();
      },
      readActivePlan: () => Promise.resolve(stored),
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });
    expect(result.plannedTargetIndexes).toEqual([1]);
    expect(result.targets[0]?.activePlan.plan.application.version).toBe('0.9.0');
  });

  it.each(['allow', 'reject'] as const)(
    'checks the assigned source with its %s policy for missing upload times',
    async (missingUploadTime) => {
      const target = config.targets[0] as WorkspacePythonApplicationTarget;
      target.resolution = {
        packageIndexes: [
          { indexUrl: 'https://vendor.test/simple/', packages: ['demo'], missingUploadTime },
        ],
      };
      const stored = activePlanFor(config, target);
      const undated = applicationFile('2.0.0');
      delete undated.uploadTime;
      const createIndexClient = vi.fn(() => fixtureIndex([applicationFile(), undated]));
      const planTargets = vi.fn(() => Promise.resolve());
      const result = await ensureWorkspacePythonApplicationPlans({
        config,
        createIndexClient,
        planTargets,
        readActivePlan: () => Promise.resolve(stored),
        readRecipe: () => Promise.resolve(undefined),
        workspaceDir,
      });
      expect(createIndexClient).toHaveBeenCalledExactlyOnceWith('https://vendor.test/simple/');
      expect(result.plannedTargetIndexes).toEqual(missingUploadTime === 'allow' ? [1] : []);
    }
  );

  it('shares one index request between moving selectors for the same application', async () => {
    const target = config.targets[0] as WorkspacePythonApplicationTarget;
    target.application.versionSelection = {
      selectors: [{ type: 'latest-compatible' }, { type: 'latest-compatible', constraint: '>=1' }],
    };
    const resolved = resolveWorkspacePythonApplication(config, target);
    const stored = new Map(
      resolved.versionSelection.selectors.map((selector) => [
        pythonApplicationSelectorId('demo', resolved.coveragePolicy.id, selector),
        activePlanFor(config, target, undefined, selector),
      ])
    );
    const index = fixtureIndex([applicationFile()]);
    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      createIndexClient: () => index,
      planTargets: () => Promise.reject(new Error('planner must not run')),
      readActivePlan: (_workspace, targetId) => Promise.resolve(stored.get(targetId)!),
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });
    expect(index.getProject).toHaveBeenCalledTimes(1);
    expect(result.plannedTargetIndexes).toEqual([]);
    expect(result.targets).toHaveLength(1);
  });

  it('reports index failures without invoking the planner or silently reusing the plan', async () => {
    const stored = activePlanFor(config, config.targets[0] as WorkspacePythonApplicationTarget);
    const planTargets = vi.fn(() => Promise.resolve());
    await expect(
      ensureWorkspacePythonApplicationPlans({
        config,
        createIndexClient: () => ({
          ...fixtureIndex([]),
          getProject: () => Promise.reject(new Error('index unavailable')),
        }),
        planTargets,
        readActivePlan: () => Promise.resolve(stored),
        readRecipe: () => Promise.resolve(undefined),
        workspaceDir,
      })
    ).rejects.toThrow('index unavailable');
    expect(planTargets).not.toHaveBeenCalled();
  });

  it('does not reuse a latest plan after its recipe expires', async () => {
    const target = config.targets[0] as WorkspacePythonApplicationTarget;
    const recipe: PythonApplicationRecipe = {
      application: 'demo',
      compatibility: { expiresAt: '2026-08-01T00:00:00.000Z' },
      id: 'demo',
      schemaVersion: 1,
      version: '1',
    };
    const stored = activePlanFor(config, target, recipe);
    await expect(
      ensureWorkspacePythonApplicationPlans({
        config,
        createIndexClient: () => fixtureIndex([applicationFile()]),
        cutoff: '2026-09-08T00:00:00.000Z',
        planTargets: () => Promise.reject(new Error('planner must not run')),
        readActivePlan: () => Promise.resolve(stored),
        readRecipe: () => Promise.resolve(recipe),
        workspaceDir,
      })
    ).rejects.toThrow('recipe demo expired');
  });

  it('invalidates an old SGLang plan when maintained sources become available', async () => {
    const target = applicationTarget('sglang');
    config.targets = [target];
    let stored = activePlanFor(config, target);
    delete stored.plan.intent.source.resolution;
    const reasons: string[] = [];
    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      onPlanRequired: (requirements) => reasons.push(...requirements.map((item) => item.reason)),
      planTargets: () => {
        stored = activePlanFor(config, target, undefined, undefined, '0.5.19');
        return Promise.resolve();
      },
      readActivePlan: () => Promise.resolve(stored),
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });
    expect(reasons).toEqual(['stale']);
    expect(
      result.targets[0]?.activePlan.plan.intent.source.resolution?.packageIndexes?.[0]?.packages
    ).toContain('cuda-tile');
  });

  it('can inspect the current latest plan without refreshing for a dry run', async () => {
    const stored = activePlanFor(config, config.targets[0] as WorkspacePythonApplicationTarget);
    const result = await ensureWorkspacePythonApplicationPlans({
      config,
      createIndexClient: () => {
        throw new Error('index must not be queried');
      },
      refreshLatest: false,
      planTargets: () => Promise.reject(new Error('planner must not run')),
      readActivePlan: () => Promise.resolve(stored),
      readRecipe: () => Promise.resolve(undefined),
      workspaceDir,
    });
    expect(result.plannedTargetIndexes).toEqual([]);
  });

  it('replans an inherited target when workspace Python defaults change', async () => {
    const target = config.targets[0] as WorkspacePythonApplicationTarget;
    let stored = activePlanFor(config, target);
    config.python!.applicationDefaults!.runtime = {
      policy: 'selected',
      versions: ['3.12'],
    };

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
    expect(result.targets[0]?.activePlan.plan.intent.python).toEqual({
      policy: 'selected',
      versions: ['3.12'],
    });
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

  it('keeps a current exact plan when publication coordinates changed', async () => {
    config.targets = [
      {
        ...applicationTarget(),
        application: {
          extras: [],
          features: {},
          versionSelection: { selectors: [{ type: 'exact', version: '1.0.0' }] },
        },
      },
    ];
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
