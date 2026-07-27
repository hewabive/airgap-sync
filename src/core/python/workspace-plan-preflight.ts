import { semanticDigest } from '../canonical-json.js';
import {
  readActivePythonApplicationPlan,
  type ActivePythonApplicationPlan,
} from './active-plan-store.js';
import type { PythonApplicationRecipe } from './application-recipe.js';
import type { PythonEnvironmentPlan } from './environment-plan.js';
import { pythonApplicationTargetId } from './application-paths.js';
import { platformCoveragePolicyDigest } from './coverage-policy.js';
import {
  resolveWorkspacePythonApplication,
  type WorkspaceConfig,
  type WorkspacePythonApplicationTarget,
} from '../workspace.js';

export type WorkspacePythonPlanRequiredReason = 'missing-or-unusable' | 'stale';

export interface WorkspacePythonPlanRequirement {
  reason: WorkspacePythonPlanRequiredReason;
  targetId: string;
  targetIndex: number;
}

export interface CurrentWorkspacePythonApplicationPlan {
  activePlan: ActivePythonApplicationPlan;
  targetId: string;
  targetIndex: number;
}

export interface EnsureWorkspacePythonApplicationPlansOptions {
  config: WorkspaceConfig;
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
  publication?: PythonEnvironmentPlan['publication'];
  recipeDigest?: string;
  resolved: ReturnType<typeof resolveWorkspacePythonApplication>;
  targetId: string;
  targetIndex: number;
}

function planIsCurrent(
  activePlan: ActivePythonApplicationPlan,
  expected: ExpectedWorkspacePythonApplicationPlan
): boolean {
  const publicationIsCurrent =
    activePlan.plan.publication && expected.publication
      ? semanticDigest(activePlan.plan.publication) === semanticDigest(expected.publication)
      : activePlan.plan.publication === expected.publication;
  return (
    semanticDigest(activePlan.plan.intent) === semanticDigest(expected.resolved.intent) &&
    activePlan.plan.coverage.digest ===
      platformCoveragePolicyDigest(expected.resolved.coveragePolicy) &&
    activePlan.plan.recipe?.digest === expected.recipeDigest &&
    publicationIsCurrent
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
    const applicationArtifactOwner = options.config.python?.applicationArtifactOwner;
    const pythonPackageOwner = options.config.python?.publishOwner;
    expected.push({
      ...(applicationArtifactOwner && pythonPackageOwner
        ? {
            publication: {
              applicationArtifactOwner,
              pythonPackageOwner,
            },
          }
        : {}),
      ...(recipe ? { recipeDigest: semanticDigest(recipe) } : {}),
      resolved,
      targetId: pythonApplicationTargetId(
        resolved.intent.application.name,
        resolved.coveragePolicy.id
      ),
      targetIndex,
    });
  }
  return expected;
}

export async function ensureWorkspacePythonApplicationPlans(
  options: EnsureWorkspacePythonApplicationPlansOptions
): Promise<EnsureWorkspacePythonApplicationPlansResult> {
  const readActivePlan = options.readActivePlan ?? readActivePythonApplicationPlan;
  const expected = await expectedPlans(options);
  const current = new Map<number, CurrentWorkspacePythonApplicationPlan>();
  const requirements: WorkspacePythonPlanRequirement[] = [];

  for (const item of expected) {
    try {
      const activePlan = await readActivePlan(options.workspaceDir, item.targetId);
      if (planIsCurrent(activePlan, item)) {
        current.set(item.targetIndex, {
          activePlan,
          targetId: item.targetId,
          targetIndex: item.targetIndex,
        });
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
    const targetIndexes = requirements.map((requirement) => requirement.targetIndex);
    await options.planTargets(targetIndexes);
    for (const requirement of requirements) {
      let activePlan: ActivePythonApplicationPlan;
      try {
        activePlan = await readActivePlan(options.workspaceDir, requirement.targetId);
      } catch (error) {
        throw new Error(
          `Planning did not create a usable active plan for ${requirement.targetId}: ${(error as Error).message}`
        );
      }
      const item = expected.find((candidate) => candidate.targetIndex === requirement.targetIndex)!;
      if (!planIsCurrent(activePlan, item)) {
        throw new Error(
          `Planning produced a stale active plan for ${requirement.targetId}; the workspace changed while planning`
        );
      }
      current.set(requirement.targetIndex, {
        activePlan,
        targetId: requirement.targetId,
        targetIndex: requirement.targetIndex,
      });
    }
  }

  return {
    plannedTargetIndexes: requirements.map((requirement) => requirement.targetIndex),
    targets: expected.map((item) => current.get(item.targetIndex)!),
  };
}
