import { describe, expect, it } from 'vitest';
import {
  assertPythonApplicationRecipeCurrent,
  normalizePythonApplicationRecipe,
  pythonRecipeIncompatibilityReason,
  resolvePythonApplicationRecipe,
} from '../../src/core/python/application-recipe.js';

const intent = {
  application: {
    extras: ['base'],
    features: {
      accelerator: 'cuda',
    },
    name: 'demo-app',
  },
  coverage: {
    policyId: 'linux',
  },
  python: {
    policy: 'auto' as const,
  },
  source: {
    type: 'pypi' as const,
  },
  updatePolicy: 'manual' as const,
};

describe('Python application recipes', () => {
  it('normalizes explicit features and contributes their declared requirements', () => {
    const recipe = normalizePythonApplicationRecipe({
      application: 'Demo_App',
      compatibility: {
        incompatibleCombinations: [
          {
            reason: 'native Windows wheels are unavailable',
            when: {
              'feature.accelerator': 'cuda',
              platformFamilyId: 'windows-x86_64',
            },
          },
        ],
        preferredPythonMinors: ['3.11'],
        requiresPython: '>=3.11,<3.12',
      },
      features: [
        {
          description: 'Acceleration backend',
          name: 'accelerator',
          values: [
            {
              dependencies: ['cuda-helper==1.0.0'],
              value: 'cuda',
            },
          ],
        },
      ],
      id: 'demo',
      requiredExtras: ['runtime'],
      schemaVersion: 1,
      version: '1',
    });

    expect(resolvePythonApplicationRecipe(recipe, intent)).toEqual({
      additionalRequirements: ['cuda-helper==1.0.0'],
      extras: ['base', 'runtime'],
    });
    expect(
      pythonRecipeIncompatibilityReason(recipe, intent, {
        applicationVersion: '1.0.0',
        platformFamilyId: 'windows-x86_64',
        pythonMinor: '3.11',
      })
    ).toBe('native Windows wheels are unavailable');
    expect(
      pythonRecipeIncompatibilityReason(recipe, intent, {
        applicationVersion: '1.0.0',
        platformFamilyId: 'linux-glibc-x86_64',
        pythonMinor: '3.11',
      })
    ).toBeUndefined();
  });

  it('rejects undeclared feature values and unsafe feature dependencies', () => {
    const recipe = normalizePythonApplicationRecipe({
      application: 'demo-app',
      features: [
        {
          description: 'Acceleration backend',
          name: 'accelerator',
          values: [{ value: 'cpu' }],
        },
      ],
      id: 'demo',
      schemaVersion: 1,
      version: '1',
    });

    expect(() => resolvePythonApplicationRecipe(recipe, intent)).toThrow('does not support cuda');
    expect(() =>
      normalizePythonApplicationRecipe({
        application: 'demo-app',
        features: [
          {
            description: 'Acceleration backend',
            name: 'accelerator',
            values: [
              {
                dependencies: ['helper; sys_platform == "linux"'],
                value: 'cuda',
              },
            ],
          },
        ],
        id: 'demo',
        schemaVersion: 1,
        version: '1',
      })
    ).toThrow('without an environment marker');
  });

  it('requires an explicit review after a maintained recipe expires', () => {
    const recipe = normalizePythonApplicationRecipe({
      application: 'demo-app',
      compatibility: {
        expiresAt: '2026-08-01T00:00:00.000Z',
      },
      id: 'demo',
      schemaVersion: 1,
      version: '1',
    });

    expect(() => {
      assertPythonApplicationRecipeCurrent(recipe, '2026-07-31T23:59:59.000Z');
    }).not.toThrow();
    expect(() => {
      assertPythonApplicationRecipeCurrent(recipe, '2026-08-01T00:00:00.000Z');
    }).toThrow('review and update');
  });
});
