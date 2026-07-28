import {
  createPythonEnvironmentPlan,
  type PythonEnvironmentPlan,
  type PythonEnvironmentPlanInput,
  type PythonPlanTransferArtifact,
  type PythonRuntimeContract,
} from './environment-plan.js';
import type { PythonApplicationRecipe } from './application-recipe.js';
import {
  managedPythonRuntimeCatalog,
  selectManagedPythonRuntimeAsset,
  type ManagedPythonRuntimeCatalog,
} from './runtime-catalog.js';
import { uvToolManifest } from './uv-tool.js';
import type { BuiltInPlatformFamilyId } from './platform-family.js';

export interface AddPythonRuntimeContractOptions {
  includeCpython?: boolean;
  includeUv?: boolean;
  recipe?: PythonApplicationRecipe;
  runtimeCatalog?: ManagedPythonRuntimeCatalog;
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

function cpythonArtifacts(
  plan: PythonEnvironmentPlan,
  catalog: ManagedPythonRuntimeCatalog
): PythonPlanTransferArtifact[] {
  return plan.platforms.map((platform) => {
    const asset = selectManagedPythonRuntimeAsset(
      platform.pythonMinor,
      platform.platformFamilyId as BuiltInPlatformFamilyId,
      catalog
    );
    if (!asset) {
      throw new Error(
        `No managed CPython ${platform.pythonMinor} artifact for ${platform.platformFamilyId}`
      );
    }
    return {
      filename: asset.filename,
      kind: 'cpython',
      license: catalog.license,
      platforms: [platform.platformFamilyId],
      sha256: asset.sha256,
      size: asset.size,
      sourceUrl: asset.url,
      version: asset.pythonVersion,
    };
  });
}

function uvAssetKey(platformFamilyId: string): string {
  switch (platformFamilyId) {
    case 'linux-glibc-x86_64':
      return 'linux-x64';
    case 'windows-x86_64':
      return 'win32-x64';
    default:
      throw new Error(`No managed uv artifact for ${platformFamilyId}`);
  }
}

function uvArtifacts(plan: PythonEnvironmentPlan): PythonPlanTransferArtifact[] {
  const platforms = plan.platforms.map((platform) => platform.platformFamilyId);
  const binaries = platforms.map((platformFamilyId) => {
    const asset = uvToolManifest.assets[uvAssetKey(platformFamilyId)]!;
    return {
      filename: asset.file,
      kind: 'uv' as const,
      license: {
        spdx: uvToolManifest.license,
        url: uvToolManifest.licenseFiles[0]!.url,
      },
      platforms: [platformFamilyId],
      sha256: asset.sha256,
      size: asset.size,
      sourceUrl: asset.url,
      version: uvToolManifest.version,
    };
  });
  const licenses = uvToolManifest.licenseFiles.map((licenseFile) => ({
    filename: `uv-${uvToolManifest.version}-${licenseFile.name}`,
    kind: 'license' as const,
    license: {
      spdx: uvToolManifest.license,
      url: licenseFile.url,
    },
    platforms: [...platforms],
    sha256: licenseFile.sha256,
    sourceUrl: licenseFile.url,
    version: uvToolManifest.version,
  }));
  return [...binaries, ...licenses];
}

export function addPythonRuntimeContract(
  plan: PythonEnvironmentPlan,
  options: AddPythonRuntimeContractOptions = {}
): PythonEnvironmentPlan {
  const runtimeArtifacts: PythonPlanTransferArtifact[] = [
    ...(options.includeCpython
      ? cpythonArtifacts(plan, options.runtimeCatalog ?? managedPythonRuntimeCatalog)
      : []),
    ...(options.includeUv ? uvArtifacts(plan) : []),
  ].sort((left, right) => left.filename.localeCompare(right.filename));
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
    ...(runtimeArtifacts.length > 0 ? { runtimeArtifacts } : {}),
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
  generatedAt = new Date().toISOString()
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
