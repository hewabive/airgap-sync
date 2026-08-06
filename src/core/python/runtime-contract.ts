import {
  createPythonEnvironmentPlan,
  type PythonEnvironmentPlan,
  type PythonEnvironmentPlanInput,
  type PythonRuntimeContract,
} from './environment-plan.js';
import type { PythonApplicationRecipe } from './application-recipe.js';

export interface AddPythonRuntimeContractOptions {
  recipe?: PythonApplicationRecipe;
}

export interface PythonPrerequisiteReport {
  application: PythonEnvironmentPlan['application'];
  generatedAt: string;
  installationOwner: 'consumer-infrastructure';
  planId: string;
  platforms: PythonRuntimeContract['platforms'];
  schemaVersion: 1;
}

function runtimeContract(
  plan: PythonEnvironmentPlan,
  recipe: PythonApplicationRecipe | undefined
): PythonRuntimeContract {
  return {
    platforms: plan.platforms.map((platform) => ({
      implementation: 'CPython',
      platformFamilyId: platform.platformFamilyId,
      provisionedExternally: true,
      pythonMinor: platform.pythonMinor,
      requiresPython: platform.requiresPython,
      systemPrerequisites: [
        ...(platform.supportBoundary?.glibc ? [`glibc >= ${platform.supportBoundary.glibc}`] : []),
        ...(recipe?.systemPrerequisites ?? []),
      ],
    })),
  };
}

export function addPythonRuntimeContract(
  plan: PythonEnvironmentPlan,
  options: AddPythonRuntimeContractOptions = {}
): PythonEnvironmentPlan {
  const input: PythonEnvironmentPlanInput = {
    application: plan.application,
    coverage: plan.coverage,
    createdAt: plan.createdAt,
    intent: plan.intent,
    platforms: plan.platforms,
    ...(plan.preferredPythonMinor ? { preferredPythonMinor: plan.preferredPythonMinor } : {}),
    ...(plan.presentation ? { presentation: plan.presentation } : {}),
    ...(plan.recipe ? { recipe: plan.recipe } : {}),
    resolver: plan.resolver,
    runtimeContract: runtimeContract(plan, options.recipe),
    schemaVersion: plan.schemaVersion,
    ...(options.recipe?.healthChecks?.length
      ? {
          verification: {
            healthChecks: options.recipe.healthChecks,
          },
        }
      : plan.verification
        ? { verification: plan.verification }
        : {}),
    wheels: plan.wheels,
  };
  return createPythonEnvironmentPlan(input);
}

export function createPythonPrerequisiteReport(
  plan: PythonEnvironmentPlan,
  generatedAt = plan.createdAt
): PythonPrerequisiteReport {
  if (!plan.runtimeContract) {
    throw new Error('Python environment plan has no runtime contract');
  }
  return {
    application: plan.application,
    generatedAt,
    installationOwner: 'consumer-infrastructure',
    planId: plan.planId,
    platforms: plan.runtimeContract.platforms,
    schemaVersion: 1,
  };
}
