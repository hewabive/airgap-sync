import {
  createPythonEnvironmentPlan,
  type PythonEnvironmentPlan,
  type PythonEnvironmentPlanInput,
  type PythonPlanTransferArtifact,
  type PythonRuntimeContract,
} from './environment-plan.js';
import type { PythonApplicationRecipe } from './application-recipe.js';
import {
  selectManagedPythonRuntimeCatalogs,
  selectManagedPythonRuntimeAsset,
  type ManagedPythonRuntimeCatalogSelection,
} from './runtime-catalog.js';
import { uvToolManifest, uvToolManifestForConsumer } from './uv-tool.js';
import type { BuiltInPlatformFamilyId } from './platform-family.js';

export interface AddPythonRuntimeContractOptions {
  includeCpython?: boolean;
  includeUv?: boolean;
  recipe?: PythonApplicationRecipe;
  runtimeCatalogSelections?: ManagedPythonRuntimeCatalogSelection[];
  uvVersions?: string[];
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
  recipe: PythonApplicationRecipe | undefined,
  uvVersions: string[] | undefined
): PythonRuntimeContract {
  return {
    ...(uvVersions?.length ? { uvVersions } : {}),
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
  selections: ManagedPythonRuntimeCatalogSelection[]
): PythonPlanTransferArtifact[] {
  const artifacts = new Map<string, PythonPlanTransferArtifact>();
  for (const platform of plan.platforms) {
    for (const selection of selections) {
      const asset = selectManagedPythonRuntimeAsset(
        platform.pythonMinor,
        platform.platformFamilyId as BuiltInPlatformFamilyId,
        selection.catalog
      );
      if (!asset) {
        throw new Error(
          `No managed CPython ${platform.pythonMinor} artifact for ${platform.platformFamilyId} compatible with uv ${selection.uvVersions.join(', ')}`
        );
      }
      const key = `${asset.sha256}\0${asset.filename}`;
      const current = artifacts.get(key);
      artifacts.set(key, {
        filename: asset.filename,
        kind: 'cpython',
        license: selection.catalog.license,
        platforms: [...new Set([...(current?.platforms ?? []), platform.platformFamilyId])].sort(),
        requiredByUvVersions: [
          ...new Set([...(current?.requiredByUvVersions ?? []), ...selection.uvVersions]),
        ].sort(),
        sha256: asset.sha256,
        size: asset.size,
        sourceUrl: asset.url,
        version: asset.pythonVersion,
      });
    }
  }
  return [...artifacts.values()];
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

function uvArtifacts(
  plan: PythonEnvironmentPlan,
  uvVersions: string[]
): PythonPlanTransferArtifact[] {
  const platforms = plan.platforms.map((platform) => platform.platformFamilyId);
  return uvVersions.flatMap((version) => {
    const manifest = uvToolManifestForConsumer(version);
    const binaries = platforms.map((platformFamilyId) => {
      const asset = manifest.assets[uvAssetKey(platformFamilyId)];
      if (!asset) {
        throw new Error(`No managed uv ${version} artifact for ${platformFamilyId}`);
      }
      return {
        filename: asset.file,
        kind: 'uv' as const,
        license: {
          spdx: manifest.license,
          url: manifest.licenseFiles[0]!.url,
        },
        platforms: [platformFamilyId],
        sha256: asset.sha256,
        size: asset.size,
        sourceUrl: asset.url,
        version: manifest.version,
      };
    });
    const licenses = manifest.licenseFiles.map((licenseFile) => ({
      filename: `uv-${manifest.version}-${licenseFile.name}`,
      kind: 'license' as const,
      license: {
        spdx: manifest.license,
        url: licenseFile.url,
      },
      platforms: [...platforms],
      sha256: licenseFile.sha256,
      sourceUrl: licenseFile.url,
      version: manifest.version,
    }));
    return [...binaries, ...licenses];
  });
}

export function addPythonRuntimeContract(
  plan: PythonEnvironmentPlan,
  options: AddPythonRuntimeContractOptions = {}
): PythonEnvironmentPlan {
  const transfersRuntime = options.includeCpython === true || options.includeUv === true;
  const uvVersions = [
    ...new Set(options.uvVersions ?? (transfersRuntime ? [uvToolManifest.version] : [])),
  ].sort();
  if (transfersRuntime && uvVersions.length === 0) {
    throw new Error('Legacy Python runtime transfer requires at least one uv version');
  }
  const runtimeCatalogSelections = options.includeCpython
    ? (options.runtimeCatalogSelections ?? selectManagedPythonRuntimeCatalogs(uvVersions))
    : [];
  const catalogUvVersions = [
    ...new Set(runtimeCatalogSelections.flatMap((selection) => selection.uvVersions)),
  ].sort();
  if (
    options.includeCpython &&
    (catalogUvVersions.length !== uvVersions.length ||
      catalogUvVersions.some((version, index) => version !== uvVersions[index]))
  ) {
    throw new Error('Managed Python runtime catalog selection does not cover every consumer uv');
  }
  const runtimeArtifacts: PythonPlanTransferArtifact[] = [
    ...(options.includeCpython ? cpythonArtifacts(plan, runtimeCatalogSelections) : []),
    ...(options.includeUv ? uvArtifacts(plan, uvVersions) : []),
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
    runtimeContract: runtimeContract(
      plan,
      options.recipe,
      transfersRuntime ? uvVersions : undefined
    ),
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
