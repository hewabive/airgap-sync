import type { PythonApplicationIntent } from './application-intent.js';
import { isValidPackageName, normalizePackageName } from './names.js';
import { isValidSpecifierSet } from './pep440.js';
import { parseRequirement } from './requirements.js';

export interface PythonApplicationRecipeCompatibility {
  applicationVersions?: string;
  expiresAt?: string;
  incompatibleCombinations?: {
    reason: string;
    when: Record<string, string>;
  }[];
  preferredPythonMinors?: string[];
  requiresPython?: string;
}

export interface PythonApplicationRecipeFeature {
  description: string;
  name: string;
  values: {
    dependencies?: string[];
    value: string;
  }[];
}

export interface PythonApplicationRecipe {
  application: string;
  compatibility?: PythonApplicationRecipeCompatibility;
  entryPoints?: string[];
  features?: PythonApplicationRecipeFeature[];
  healthChecks?: {
    args: string[];
    command: string;
  }[];
  id: string;
  requiredExtras?: string[];
  schemaVersion: 1;
  systemPrerequisites?: string[];
  upstreamDocumentation?: string[];
  version: string;
}

export interface ResolvedPythonApplicationRecipe {
  additionalRequirements: string[];
  extras: string[];
}

export interface PythonRecipeCandidateContext {
  applicationVersion: string;
  platformFamilyId: string;
  pythonMinor: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value.trim();
}

function optionalStringArray(value: unknown, description: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw new Error(`${description} must contain non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function normalizeRequirement(value: string, description: string): string {
  const parsed = parseRequirement(value);
  if (!parsed.ok || parsed.requirement.url || parsed.requirement.marker) {
    throw new Error(`${description} must be a registry requirement without an environment marker`);
  }
  return value.trim();
}

function normalizeCompatibility(value: unknown): PythonApplicationRecipeCompatibility | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('recipe compatibility must be an object');
  }
  const applicationVersions =
    value.applicationVersions === undefined
      ? undefined
      : requiredString(value.applicationVersions, 'recipe applicationVersions');
  const requiresPython =
    value.requiresPython === undefined
      ? undefined
      : requiredString(value.requiresPython, 'recipe requiresPython');
  if (applicationVersions && !isValidSpecifierSet(applicationVersions)) {
    throw new Error('recipe applicationVersions must be a valid version specifier');
  }
  if (requiresPython && !isValidSpecifierSet(requiresPython)) {
    throw new Error('recipe requiresPython must be a valid version specifier');
  }
  const preferredPythonMinors = optionalStringArray(
    value.preferredPythonMinors,
    'recipe preferredPythonMinors'
  );
  if (preferredPythonMinors?.some((minor) => !/^3\.\d+$/u.test(minor))) {
    throw new Error('recipe preferredPythonMinors must use 3.X form');
  }
  let incompatibleCombinations:
    | PythonApplicationRecipeCompatibility['incompatibleCombinations']
    | undefined;
  if (value.incompatibleCombinations !== undefined) {
    if (!Array.isArray(value.incompatibleCombinations)) {
      throw new Error('recipe incompatibleCombinations must be an array');
    }
    incompatibleCombinations = value.incompatibleCombinations.map((item) => {
      if (!isRecord(item) || !isRecord(item.when)) {
        throw new Error('recipe incompatible combination must contain a when object');
      }
      const when = Object.fromEntries(
        Object.entries(item.when).map(([key, condition]) => [
          requiredString(key, 'recipe incompatibility key'),
          requiredString(condition, `recipe incompatibility ${key}`),
        ])
      );
      if (Object.keys(when).length === 0) {
        throw new Error('recipe incompatible combination must contain at least one condition');
      }
      return {
        reason: requiredString(item.reason, 'recipe incompatibility reason'),
        when,
      };
    });
  }
  const expiresAt =
    value.expiresAt === undefined ? undefined : requiredString(value.expiresAt, 'recipe expiresAt');
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('recipe expiresAt must be an ISO timestamp');
  }
  return {
    ...(applicationVersions ? { applicationVersions } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(incompatibleCombinations ? { incompatibleCombinations } : {}),
    ...(preferredPythonMinors ? { preferredPythonMinors } : {}),
    ...(requiresPython ? { requiresPython } : {}),
  };
}

function normalizeFeatures(value: unknown): PythonApplicationRecipeFeature[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('recipe features must be an array');
  }
  const features = value.map((feature) => {
    if (!isRecord(feature) || !Array.isArray(feature.values) || feature.values.length === 0) {
      throw new Error('each recipe feature must contain at least one value');
    }
    const name = requiredString(feature.name, 'recipe feature name');
    const values = feature.values.map((item) => {
      if (!isRecord(item)) {
        throw new Error(`recipe feature ${name} values must be objects`);
      }
      const dependencies = optionalStringArray(
        item.dependencies,
        `recipe feature ${name} dependencies`
      )?.map((dependency) => normalizeRequirement(dependency, `recipe feature ${name} dependency`));
      return {
        ...(dependencies ? { dependencies } : {}),
        value: requiredString(item.value, `recipe feature ${name} value`),
      };
    });
    if (new Set(values.map((item) => item.value)).size !== values.length) {
      throw new Error(`recipe feature ${name} contains duplicate values`);
    }
    return {
      description: requiredString(feature.description, `recipe feature ${name} description`),
      name,
      values,
    };
  });
  if (new Set(features.map((feature) => feature.name)).size !== features.length) {
    throw new Error('recipe contains duplicate feature names');
  }
  return features;
}

export function normalizePythonApplicationRecipe(value: unknown): PythonApplicationRecipe {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Python application recipe schemaVersion must be 1');
  }
  const application = normalizePackageName(requiredString(value.application, 'recipe application'));
  if (!isValidPackageName(application)) {
    throw new Error('recipe application must be a valid package name');
  }
  const requiredExtras = optionalStringArray(value.requiredExtras, 'recipe requiredExtras');
  if (requiredExtras?.some((extra) => !isValidPackageName(extra))) {
    throw new Error('recipe requiredExtras must contain valid extra names');
  }
  let healthChecks: PythonApplicationRecipe['healthChecks'];
  if (value.healthChecks !== undefined) {
    if (!Array.isArray(value.healthChecks)) {
      throw new Error('recipe healthChecks must be an array');
    }
    healthChecks = value.healthChecks.map((check) => {
      if (!isRecord(check) || !Array.isArray(check.args)) {
        throw new Error('recipe health checks must contain command and args');
      }
      return {
        args: check.args.map((arg) => requiredString(arg, 'recipe health check arg')),
        command: requiredString(check.command, 'recipe health check command'),
      };
    });
  }
  const compatibility = normalizeCompatibility(value.compatibility);
  const entryPoints = optionalStringArray(value.entryPoints, 'recipe entryPoints');
  const features = normalizeFeatures(value.features);
  const systemPrerequisites = optionalStringArray(
    value.systemPrerequisites,
    'recipe systemPrerequisites'
  );
  const upstreamDocumentation = optionalStringArray(
    value.upstreamDocumentation,
    'recipe upstreamDocumentation'
  );
  for (const url of upstreamDocumentation ?? []) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('recipe upstreamDocumentation URLs must use HTTP or HTTPS');
    }
  }
  return {
    application,
    ...(compatibility ? { compatibility } : {}),
    ...(entryPoints ? { entryPoints } : {}),
    ...(features ? { features } : {}),
    ...(healthChecks ? { healthChecks } : {}),
    id: requiredString(value.id, 'recipe id'),
    ...(requiredExtras
      ? { requiredExtras: requiredExtras.map((extra) => normalizePackageName(extra)) }
      : {}),
    schemaVersion: 1,
    ...(systemPrerequisites ? { systemPrerequisites } : {}),
    ...(upstreamDocumentation ? { upstreamDocumentation } : {}),
    version: requiredString(value.version, 'recipe version'),
  };
}

export function resolvePythonApplicationRecipe(
  recipe: PythonApplicationRecipe | undefined,
  intent: PythonApplicationIntent
): ResolvedPythonApplicationRecipe {
  if (!recipe) {
    return {
      additionalRequirements: [],
      extras: [...intent.application.extras],
    };
  }
  if (normalizePackageName(recipe.application) !== normalizePackageName(intent.application.name)) {
    throw new Error(
      `Python application recipe ${recipe.id} is for ${recipe.application}, not ${intent.application.name}`
    );
  }
  const declared = new Map((recipe.features ?? []).map((feature) => [feature.name, feature]));
  const additionalRequirements: string[] = [];
  for (const [name, selectedValue] of Object.entries(intent.application.features)) {
    const feature = declared.get(name);
    if (!feature) {
      throw new Error(`Python application recipe ${recipe.id} does not define feature ${name}`);
    }
    const selected = feature.values.find((value) => value.value === selectedValue);
    if (!selected) {
      throw new Error(
        `Python application recipe ${recipe.id} feature ${name} does not support ${selectedValue}`
      );
    }
    additionalRequirements.push(...(selected.dependencies ?? []));
  }
  return {
    additionalRequirements: [...new Set(additionalRequirements)].sort(),
    extras: [...new Set([...intent.application.extras, ...(recipe.requiredExtras ?? [])])].sort(),
  };
}

export function pythonRecipeIncompatibilityReason(
  recipe: PythonApplicationRecipe | undefined,
  intent: PythonApplicationIntent,
  context: PythonRecipeCandidateContext
): string | undefined {
  for (const combination of recipe?.compatibility?.incompatibleCombinations ?? []) {
    const matches = Object.entries(combination.when).every(([key, value]) => {
      if (key === 'platformFamilyId') {
        return context.platformFamilyId === value;
      }
      if (key === 'pythonMinor') {
        return context.pythonMinor === value;
      }
      if (key === 'applicationVersion') {
        return context.applicationVersion === value;
      }
      if (key.startsWith('feature.')) {
        return intent.application.features[key.slice('feature.'.length)] === value;
      }
      throw new Error(`Unsupported Python recipe incompatibility condition: ${key}`);
    });
    if (matches) {
      return combination.reason;
    }
  }
  return undefined;
}
