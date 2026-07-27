import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import {
  findMaintainedPythonApplicationRecipe,
  installMaintainedPythonApplicationRecipe,
  listMaintainedPythonApplicationRecipes,
} from '../../src/core/python/maintained-recipes.js';

let tempDir: string;

describe('maintained Python application recipes', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-maintained-recipe-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('matches package requirements and installs a workspace-local reviewed copy', async () => {
    const maintained = findMaintainedPythonApplicationRecipe('KTransformers==0.6.1.post1');
    expect(maintained).toMatchObject({
      recipe: {
        application: 'ktransformers',
        id: 'ktransformers-0.6.1.post1',
      },
      workspacePath: '.airgap-sync/recipes/ktransformers-0.6.1.post1.json',
    });
    const workspacePath = await installMaintainedPythonApplicationRecipe(tempDir, maintained!);

    expect(await fs.readJson(path.join(tempDir, workspacePath))).toEqual(maintained!.recipe);
    expect(listMaintainedPythonApplicationRecipes()).toHaveLength(1);
  });

  it('does not overwrite a workspace-local recipe customized by the operator', async () => {
    const maintained = findMaintainedPythonApplicationRecipe('ktransformers')!;
    const recipePath = path.join(tempDir, maintained.workspacePath);
    await fs.ensureDir(path.dirname(recipePath));
    await fs.writeJson(recipePath, {
      ...maintained.recipe,
      version: 'workspace-review',
    });

    await installMaintainedPythonApplicationRecipe(tempDir, maintained);

    expect(await fs.readJson(recipePath)).toMatchObject({
      version: 'workspace-review',
    });
  });
});
