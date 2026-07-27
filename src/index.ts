export const packageName = 'airgap-sync';
export const packageVersion = '0.1.0';

export {
  createBundleDocuments,
  createFetchReport,
  readBundleManifest,
  readDistTagsManifest,
  readFetchReport,
  writeApplyReport,
  writeBundleDocuments,
  writeCollectReport,
  writeFetchReport,
  writeGiteaRepositoryProvisionReport,
  writeGitApplyReport,
  writeGitConfigReport,
  writeGitFetchReport,
  writePublishReport,
  writeVerifyInstallReport,
  writeVerifyReport,
  writeWorkspaceSnapshot,
} from './core/bundle.js';
export { applyBundle } from './core/apply.js';
export { collectBundle } from './core/collect.js';
export { HttpPythonIndexClient } from './core/python/index-client.js';
export { publishPythonBundle } from './core/python/publisher.js';
export { canonicalizeJson, canonicalJson, semanticDigest } from './core/canonical-json.js';
export {
  pythonApplicationPlanDirectory,
  pythonApplicationPlanPath,
  pythonApplicationTargetId,
  pythonApplicationsDirectory,
} from './core/python/application-paths.js';
export {
  createPythonEnvironmentPlan,
  pythonEnvironmentPlanId,
  pythonEnvironmentPlanSemanticContent,
  serializePythonEnvironmentPlan,
} from './core/python/environment-plan.js';
export {
  defaultPythonPlannerPolicy,
  generatePythonPlannerCandidates,
  planPythonApplication,
  PythonApplicationPlanningError,
} from './core/python/application-planner.js';
export {
  addPythonRuntimeContract,
  createPythonPrerequisiteReport,
} from './core/python/runtime-contract.js';
export {
  managedPythonRuntimeCatalog,
  normalizeManagedPythonRuntimeCatalog,
  selectManagedPythonRuntimeAsset,
} from './core/python/runtime-catalog.js';
export {
  transferPythonPlanArtifacts,
  verifyPythonPlanArtifactManifest,
} from './core/python/plan-artifact-transfer.js';
export {
  classifyUvResolutionFailure,
  createUvCompileInvocation,
  defaultUvCommandRunner,
  UvApplicationResolver,
  UvResolutionError,
  uvPlatformTarget,
} from './core/python/uv-adapter.js';
export { acquireUv, uvCollectorAssetKey, uvToolManifest } from './core/python/uv-tool.js';
export {
  builtInDistributionHintCatalog,
  normalizeDistributionHintCatalog,
} from './core/python/distribution-hints.js';
export {
  compareCompatibilityVersions,
  explainPlatformCoveragePolicy,
} from './core/python/coverage-explain.js';
export {
  compareMachineToPythonEnvironmentPlan,
  normalizeMachineProbeFacts,
  probeMachine,
} from './core/python/probe.js';
export {
  normalizeInlinePlatformCoveragePolicy,
  normalizePlatformCoveragePolicy,
  platformCoveragePolicyDigest,
} from './core/python/coverage-policy.js';
export {
  getBuiltInPlatformFamily,
  isBuiltInPlatformFamilyId,
  listBuiltInPlatformFamilies,
} from './core/python/platform-family.js';
export { applyGitSources, createGitConfigRewriteRules } from './core/git-apply.js';
export { resolveGitPublishTargets } from './core/git-publish-targets.js';
export type {
  GitOwnerStrategy,
  GitPublishOwnerKind,
  ResolveGitPublishTargetsOptions,
} from './core/git-publish-targets.js';
export { configureGitRewrites } from './core/git-config.js';
export { fetchSeedBundle } from './core/fetcher.js';
export { packageFileName } from './core/files.js';
export { readGitSourceManifestRequirements } from './core/git-manifests.js';
export {
  assumeGiteaRepositoriesExist,
  HttpGiteaClient,
  provisionGiteaRepositories,
} from './core/gitea.js';
export { fetchGitSources, runGitCommand } from './core/git-fetch.js';
export { readStableTagResolutionIndex } from './core/tag-resolution.js';
export {
  captureBundleState,
  writeDownloadRunHistory,
  writePublishRunHistory,
} from './core/run-history.js';
export {
  createGitSourcesManifest,
  createGitSourceFromUrl,
  readGitSourcesManifest,
  writeGitSourcesManifest,
} from './core/git-sources.js';
export { readBundleInfo } from './core/info.js';
export { readManifestRequirements } from './core/manifests.js';
export {
  readRegistryMetadataCache,
  RegistryMetadataCache,
  writeRegistryMetadataCache,
} from './core/metadata-cache.js';
export { findGitRepositories, runGitOutputCommand, updateRepositories } from './core/repos.js';
export {
  CachedRegistryClient,
  HttpRegistryClient,
  isBlockedPublishRegistry,
} from './core/registry.js';
export { createPublishPlan, publishBundle } from './core/publisher.js';
export { pruneBundle, writePruneReport } from './core/prune.js';
export { resolveRootRequirementFromMetadata, resolveRootRequirements } from './core/resolver.js';
export { parseDependencySpec, parseRootSpecs } from './core/specs.js';
export { throwIfInvalidBundle, validateBundle } from './core/validation.js';
export { verifyBundle } from './core/verify.js';
export { runInstallCommand, verifyInstall } from './core/verify-install.js';
export {
  addWorkspaceTarget,
  clearWorkspaceGiteaToken,
  createWorkspaceGitSources,
  createWorkspacePythonRequirements,
  createWorkspacePythonRootWheels,
  createWorkspacePythonRuntimeArtifacts,
  createWorkspaceSnapshot,
  defaultWorkspaceOutputDir,
  defaultWorkspaceSourceRegistry,
  initWorkspace,
  previewWorkspaceConfigMigration,
  readWorkspaceConfig,
  readWorkspaceSecrets,
  removeWorkspaceTarget,
  resolveWorkspacePythonApplication,
  saveWorkspaceGiteaToken,
  selectWorkspaceTargets,
  setWorkspaceTargetPythonResolutionMode,
  workspaceConfigFileName,
  workspaceConfigPath,
  workspaceLegacyPythonSettings,
  workspaceSecretsFileName,
  workspaceSecretsPath,
  workspacePythonPlannerVersion,
  withWorkspaceLegacyPythonSettings,
  writeWorkspaceConfig,
  writeWorkspaceSecrets,
} from './core/workspace.js';
export {
  dependencySpecsFromManifest,
  downloadResolvedPackage,
  readPackageManifest,
} from './core/tarball.js';
export {
  parseLockfileRequirementsFromContent,
  parseNpmLockRequirementsFromContent,
  parsePnpmLockRequirementsFromContent,
  parseYarnLockRequirementsFromContent,
  readLockfileRequirements,
} from './core/lockfiles.js';

export type { BundleDocuments, BundleDocumentsOptions, FetchReportOptions } from './core/bundle.js';
export type {
  ApplyBundleOptions,
  ApplyProgressEvent,
  ApplyProgressPhase,
  ApplyProgressStatus,
} from './core/apply.js';
export type {
  CollectBundleOptions,
  CollectProgressEvent,
  CollectProgressPhase,
  CollectProgressStatus,
} from './core/collect.js';
export type {
  FetchProgressEvent,
  FetchProgressPhase,
  FetchProgressStatus,
  FetchSeedBundleOptions,
  FetchSeedBundleResult,
} from './core/fetcher.js';
export type { ApplyGitSourcesOptions, GitHttpAuth } from './core/git-apply.js';
export type { ConfigureGitRewritesOptions } from './core/git-config.js';
export type {
  GiteaClient,
  HttpGiteaClientOptions,
  AssumeGiteaRepositoriesExistOptions,
  ProvisionGiteaRepositoriesOptions,
} from './core/gitea.js';
export type {
  FetchGitSourcesOptions,
  GitFetchProgressEvent,
  GitFetchProgressStatus,
  GitCommandInvocation,
  GitCommandRunner,
} from './core/git-fetch.js';
export type {
  GitSourceManifestRequirementsResult,
  ReadGitSourceManifestRequirementsOptions,
} from './core/git-manifests.js';
export type { GitSourcesOptions } from './core/git-sources.js';
export type {
  BundleInfo,
  BundleInfoPackage,
  BundleInfoReportStatus,
  BundleInfoTag,
} from './core/info.js';
export type { ReadManifestRequirementsOptions } from './core/manifests.js';
export type {
  PublishBundleOptions,
  PublishProgressEvent,
  PublishProgressPhase,
  PublishProgressStatus,
} from './core/publisher.js';
export type { PruneBundleOptions } from './core/prune.js';
export type {
  GitOutputCommandInvocation,
  GitOutputCommandResult,
  GitOutputCommandRunner,
  RepositoryUpdateProgressEvent,
  RepositoryUpdateProgressStatus,
  UpdateRepositoriesOptions,
} from './core/repos.js';
export type {
  BundleValidationIssue,
  BundleValidationResult,
  BundleValidationSeverity,
} from './core/validation.js';
export type { VerifyBundleOptions } from './core/verify.js';
export type {
  InstallCommandInvocation,
  InstallCommandResult,
  InstallCommandRunner,
  VerifyInstallOptions,
} from './core/verify-install.js';
export type {
  InitWorkspaceOptions,
  PythonResolutionMode,
  ResolvedWorkspacePythonApplication,
  WorkspaceConfig,
  WorkspaceDefaults,
  WorkspaceGitTarget,
  WorkspaceLegacyPythonSettings,
  WorkspaceNpmTarget,
  WorkspacePypiTarget,
  WorkspacePromptBoolean,
  WorkspacePythonWheelTarget,
  WorkspacePythonApplicationTarget,
  WorkspacePythonConfig,
  WorkspacePythonLegacySeedConfig,
  WorkspacePythonRuntimeTarget,
  WorkspaceSecrets,
  WorkspaceSnapshot,
  WorkspaceTarget,
  WorkspaceTargetSnapshot,
  SelectWorkspaceTargetsResult,
} from './core/workspace.js';

export type { DownloadedTarball } from './core/tarball.js';
export type { CanonicalJsonPrimitive, CanonicalJsonValue } from './core/canonical-json.js';
export type {
  PlanPythonApplicationOptions,
  PlanPythonApplicationResult,
  PythonPlannerCandidate,
  PythonPlannerEvidence,
  PythonPlannerPolicy,
  PythonPlannerRejection,
} from './core/python/application-planner.js';
export type {
  AddPythonRuntimeContractOptions,
  PythonPrerequisiteReport,
} from './core/python/runtime-contract.js';
export type {
  ManagedPythonRuntimeAsset,
  ManagedPythonRuntimeCatalog,
} from './core/python/runtime-catalog.js';
export type {
  PythonPlanArtifactManifest,
  PythonPlanArtifactManifestEntry,
  TransferPythonPlanArtifactsOptions,
} from './core/python/plan-artifact-transfer.js';
export type {
  PythonApplicationResolver,
  UvCommandInvocation,
  UvCommandResult,
  UvCommandRunner,
  UvResolveRequest,
  UvResolutionErrorKind,
  UvResolutionEvidence,
} from './core/python/uv-adapter.js';
export type { AcquireUvOptions, UvToolAsset, UvToolManifest } from './core/python/uv-tool.js';
export type {
  BuiltInPlatformFamilyId,
  PlatformArchitecture,
  PlatformFamily,
  PlatformFamilyStatus,
  PlatformLibcFamily,
  PlatformOsFamily,
} from './core/python/platform-family.js';
export type {
  InlinePlatformCoveragePolicy,
  LinuxCoverageConstraint,
  PlatformCoveragePolicy,
  PythonWheelCollectionStrategy,
} from './core/python/coverage-policy.js';
export type {
  DistributionHint,
  DistributionHintCatalog,
} from './core/python/distribution-hints.js';
export type {
  PlatformCoverageExplanation,
  PlatformCoveragePolicyExplanation,
} from './core/python/coverage-explain.js';
export type {
  MachineProbeFacts,
  ProbeArchitecture,
  ProbeCheck,
  ProbeCommandResult,
  ProbeCommandRunner,
  ProbeComparison,
  ProbeMachineOptions,
  ProbeOsFamily,
} from './core/python/probe.js';
export type {
  PythonApplicationIntent,
  PythonApplicationSelection,
  PythonRuntimePolicy,
} from './core/python/application-intent.js';
export type {
  PythonApplicationRecipe,
  PythonApplicationRecipeCompatibility,
  PythonApplicationRecipeFeature,
} from './core/python/application-recipe.js';
export type {
  PythonEnvironmentPlan,
  PythonEnvironmentPlanInput,
  PythonEnvironmentPlanPresentation,
  PythonLockedPackagePlan,
  PythonPlanWheel,
  PythonPlanTransferArtifact,
  PythonPlatformPlan,
  PythonRuntimeContract,
} from './core/python/environment-plan.js';

export type { HttpRegistryClientOptions, RegistryClient } from './core/registry.js';
export type {
  PublishPythonBundleOptions,
  PythonPublishAction,
  PythonPublishAuth,
  PythonPublishReport,
} from './core/python/publisher.js';

export type {
  ApplyBundleReport,
  BundleManifest,
  BundlePruneActionResult,
  BundlePruneActionStatus,
  BundlePruneObjectSummary,
  BundlePruneObjectType,
  BundlePruneReport,
  CollectTimings,
  CollectReport,
  DistTagsManifest,
  FetchReport,
  FetchTimings,
  GiteaOrganizationActionResult,
  GiteaOrganizationActionStatus,
  GiteaRepositoryActionResult,
  GiteaRepositoryActionStatus,
  GiteaRepositoryProvisionReport,
  GitApplyActionResult,
  GitApplyActionStatus,
  GitApplyReport,
  GitConfigActionResult,
  GitConfigActionStatus,
  GitConfigReport,
  GitConfigRewriteRule,
  GitFetchActionResult,
  GitFetchActionStatus,
  GitFetchReport,
  GitRequirement,
  GitSource,
  GitSourcesManifest,
  LatestPolicy,
  RangeResolutionPolicy,
  TagResolutionPolicy,
  PackageMetadata,
  PackageManifest,
  RegistryMetadataCacheManifest,
  PackageVersionMetadata,
  ParseRootSpecsResult,
  PackageIdentity,
  ProjectPackageManifest,
  PublishActionResult,
  PublishActionStatus,
  PublishTimings,
  PublishReport,
  RepositoryUpdateReport,
  RepositoryUpdateResult,
  RepositoryUpdateStatus,
  ResolutionError,
  ResolutionReason,
  ResolveRootRequirementsResult,
  ResolvedRootPackage,
  RootPackageRequirement,
  ResolvedPackage,
  SupportedSpecType,
  TagRequirement,
  SkippedGitRequirement,
  UnsupportedRootPackageRequirement,
  VerifyCheck,
  VerifyCheckStatus,
  VerifyInstallPackageManager,
  VerifyInstallProjectResult,
  VerifyInstallProjectStatus,
  VerifyInstallReport,
  VerifyReport,
} from './types.js';
