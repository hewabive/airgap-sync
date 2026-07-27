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
