import { semanticDigest } from '../canonical-json.js';
import {
  readActivePythonApplicationPlan,
  type ActivePythonApplicationPlan,
} from './active-plan-store.js';
import type { PythonApplicationRecipe } from './application-recipe.js';
import {
  pythonApplicationSelectorId,
  pythonApplicationTargetId,
  pythonApplicationVariantId,
} from './application-paths.js';
import type { PythonApplicationVersionSelector } from './application-intent.js';
import { platformCoveragePolicyDigest } from './coverage-policy.js';
import {
  pythonApplicationIntentForVersionSelector,
  resolveWorkspacePythonApplication,
  type WorkspaceConfig,
  type WorkspacePythonApplicationTarget,
} from '../workspace.js';

export type WorkspacePythonPlanRequiredReason = 'missing-or-unusable' | 'stale' | 'refresh-latest';

export interface WorkspacePythonPlanRequirement {
  reason: WorkspacePythonPlanRequiredReason;
  targetId: string;
  targetIndex: number;
}

export interface CurrentWorkspacePythonApplicationPlan {
  activePlan: ActivePythonApplicationPlan;
  selector: PythonApplicationVersionSelector;
  selectionId: string;
  targetId: string;
  targetIndex: number;
}

export interface EnsureWorkspacePythonApplicationPlansOptions {
  config: WorkspaceConfig;
  refreshLatest?: boolean;
  onPlanRequired?: (requirements: WorkspacePythonPlanRequirement[]) => void;
  planTargets: (targetIndexes: number[]) => Promise<void>;
  readActivePlan?: (workspaceDir: string, targetId: string) => Promise<ActivePythonApplicationPlan>;
  readRecipe: (
    target: WorkspacePythonApplicationTarget
  ) => Promise<PythonApplicationRecipe | undefined>;
  targetIndexes?: number[];
  workspaceDir: string;
}

export interface EnsureWorkspacePythonApplicationPlansResult {
  plannedTargetIndexes: number[];
  targets: CurrentWorkspacePythonApplicationPlan[];
}

interface ExpectedWorkspacePythonApplicationPlan {
  intent: ReturnType<typeof pythonApplicationIntentForVersionSelector>;
  recipeDigest?: string;
  resolved: ReturnType<typeof resolveWorkspacePythonApplication>;
  selector: PythonApplicationVersionSelector;
  targetId: string;
  targetIndex: number;
}

function planIsCurrent(
  activePlan: ActivePythonApplicationPlan,
  expected: ExpectedWorkspacePythonApplicationPlan
): boolean {
  return (
    semanticDigest(activePlan.plan.intent) === semanticDigest(expected.intent) &&
    activePlan.plan.coverage.digest ===
      platformCoveragePolicyDigest(expected.resolved.coveragePolicy) &&
    activePlan.plan.recipe?.digest === expected.recipeDigest
  );
}

async function expectedPlans(
  options: EnsureWorkspacePythonApplicationPlansOptions
): Promise<ExpectedWorkspacePythonApplicationPlan[]> {
  const selectedIndexes = options.targetIndexes ? new Set(options.targetIndexes) : undefined;
  const expected: ExpectedWorkspacePythonApplicationPlan[] = [];
  for (const [offset, target] of options.config.targets.entries()) {
    const targetIndex = offset + 1;
    if (target.type !== 'python-app' || (selectedIndexes && !selectedIndexes.has(targetIndex))) {
      continue;
    }
    const resolved = resolveWorkspacePythonApplication(options.config, target);
    const recipe = await options.readRecipe(target);
    expected.push(
      ...resolved.versionSelection.selectors.map((selector) => ({
        intent: pythonApplicationIntentForVersionSelector(resolved, selector),
        ...(recipe ? { recipeDigest: semanticDigest(recipe) } : {}),
        resolved,
        selector,
        targetId: pythonApplicationSelectorId(
          resolved.intent.application.name,
          resolved.coveragePolicy.id,
          selector
        ),
        targetIndex,
      }))
    );
  }
  return expected;
}

export async function ensureWorkspacePythonApplicationPlans(
  options: EnsureWorkspacePythonApplicationPlansOptions
): Promise<EnsureWorkspacePythonApplicationPlansResult> {
  const readActivePlan = options.readActivePlan ?? readActivePythonApplicationPlan;
  const expected = await expectedPlans(options);
  const current = new Map<string, CurrentWorkspacePythonApplicationPlan>();
  const requirements: WorkspacePythonPlanRequirement[] = [];

  const currentPlan = (
    item: ExpectedWorkspacePythonApplicationPlan,
    activePlan: ActivePythonApplicationPlan
  ): CurrentWorkspacePythonApplicationPlan => ({
    activePlan,
    selector: item.selector,
    selectionId: pythonApplicationTargetId(
      activePlan.plan.application.name,
      activePlan.plan.coverage.policy.id
    ),
    targetId: pythonApplicationVariantId(
      activePlan.plan.application.name,
      activePlan.plan.application.version,
      activePlan.plan.coverage.policy.id
    ),
    targetIndex: item.targetIndex,
  });

  for (const item of expected) {
    try {
      const activePlan = await readActivePlan(options.workspaceDir, item.targetId);
      if (planIsCurrent(activePlan, item)) {
        if (options.refreshLatest !== false && item.selector.type === 'latest-compatible') {
          requirements.push({
            reason: 'refresh-latest',
            targetId: item.targetId,
            targetIndex: item.targetIndex,
          });
          continue;
        }
        current.set(item.targetId, currentPlan(item, activePlan));
      } else {
        requirements.push({
          reason: 'stale',
          targetId: item.targetId,
          targetIndex: item.targetIndex,
        });
      }
    } catch {
      requirements.push({
        reason: 'missing-or-unusable',
        targetId: item.targetId,
        targetIndex: item.targetIndex,
      });
    }
  }

  if (requirements.length > 0) {
    options.onPlanRequired?.(requirements);
    const targetIndexes = [...new Set(requirements.map((requirement) => requirement.targetIndex))];
    await options.planTargets(targetIndexes);
    const plannedIndexes = new Set(targetIndexes);
    for (const item of expected.filter((candidate) => plannedIndexes.has(candidate.targetIndex))) {
      let activePlan: ActivePythonApplicationPlan;
      try {
        activePlan = await readActivePlan(options.workspaceDir, item.targetId);
      } catch (error) {
        throw new Error(
          `Planning did not create a usable active plan for ${item.targetId}: ${(error as Error).message}`
        );
      }
      if (!planIsCurrent(activePlan, item)) {
        throw new Error(
          `Planning produced a stale active plan for ${item.targetId}; the workspace changed while planning`
        );
      }
      current.set(item.targetId, currentPlan(item, activePlan));
    }
  }

  const variants = new Map<string, CurrentWorkspacePythonApplicationPlan>();
  for (const item of expected) {
    const candidate = current.get(item.targetId)!;
    const previous = variants.get(candidate.targetId);
    if (!previous || (previous.selector.type !== 'exact' && candidate.selector.type === 'exact')) {
      variants.set(candidate.targetId, candidate);
    }
  }

  return {
    plannedTargetIndexes: [...new Set(requirements.map((requirement) => requirement.targetIndex))],
    targets: [...variants.values()],
  };
}
