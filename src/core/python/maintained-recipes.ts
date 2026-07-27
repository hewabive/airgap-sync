import path from 'node:path';
import ktransformersRecipeJson from '../../../support/python/recipes/ktransformers-0.6.1.post1.json' with { type: 'json' };
import * as fs from '../fs.js';
import {
  normalizePythonApplicationRecipe,
  type PythonApplicationRecipe,
} from './application-recipe.js';
import { normalizePackageName } from './names.js';
import { parseRequirement } from './requirements.js';

export interface MaintainedPythonApplicationRecipe {
  recipe: PythonApplicationRecipe;
  workspacePath: string;
}

const recipes: MaintainedPythonApplicationRecipe[] = [
  {
    recipe: normalizePythonApplicationRecipe(ktransformersRecipeJson),
    workspacePath: '.airgap-sync/recipes/ktransformers-0.6.1.post1.json',
  },
];

function cloneRecipe(
  maintained: MaintainedPythonApplicationRecipe
): MaintainedPythonApplicationRecipe {
  return structuredClone(maintained);
}

export function listMaintainedPythonApplicationRecipes(): MaintainedPythonApplicationRecipe[] {
  return recipes.map(cloneRecipe);
}

export function findMaintainedPythonApplicationRecipe(
  application: string
): MaintainedPythonApplicationRecipe | undefined {
  const parsed = parseRequirement(application);
  const normalized = parsed.ok
    ? parsed.requirement.normalizedName
    : normalizePackageName(application);
  const maintained = recipes.find((candidate) => candidate.recipe.application === normalized);
  return maintained ? cloneRecipe(maintained) : undefined;
}

export async function installMaintainedPythonApplicationRecipe(
  workspaceDir: string,
  maintained: MaintainedPythonApplicationRecipe
): Promise<string> {
  const recipePath = path.resolve(workspaceDir, maintained.workspacePath);
  if (await fs.pathExists(recipePath)) {
    return maintained.workspacePath;
  }
  await fs.ensureDir(path.dirname(recipePath));
  await fs.writeJson(recipePath, maintained.recipe, { spaces: 2 });
  return maintained.workspacePath;
}

export async function installMaintainedPythonApplicationRecipes(
  workspaceDir: string
): Promise<void> {
  for (const maintained of recipes) {
    await installMaintainedPythonApplicationRecipe(workspaceDir, maintained);
  }
}
