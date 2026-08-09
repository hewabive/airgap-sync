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
export { HttpPythonIndexClient, MemoizedPythonIndexClient } from './core/python/index-client.js';
export { startPythonBundleIndexServer } from './core/python/bundle-index-server.js';
export { publishPythonBundle } from './core/python/publisher.js';
export { canonicalizeJson, canonicalJson, semanticDigest } from './core/canonical-json.js';
export {
  pythonApplicationIndexPath,
  pythonApplicationPlanDirectory,
  pythonApplicationPlanPath,
  pythonApplicationSelectorId,
  pythonApplicationTargetId,
  pythonApplicationVariantId,
  pythonApplicationsDirectory,
  pythonCompatibilityCellId,
  pythonOptionalArtifactsDirectory,
  pythonPlatformLockBase,
  pythonPlatformPylockPath,
  pythonPlatformRequirementsLockPath,
  pythonWheelArtifactsDirectory,
} from './core/python/application-paths.js';
export {
  activePythonApplicationPlanDirectory,
  pruneInactivePythonApplicationPlans,
  readActivePythonApplicationPlan,
  writeActivePythonApplicationPlan,
} from './core/python/active-plan-store.js';
export { ensureWorkspacePythonApplicationPlans } from './core/python/workspace-plan-preflight.js';
export {
  downloadPythonApplicationPlans,
  readPythonApplicationBundleIndex,
  verifyPythonApplicationBundle,
} from './core/python/application-bundle.js';
export { comparePythonEnvironmentPlans, formatPythonPlanDiff } from './core/python/plan-diff.js';
export {
  createPythonConsumerBundleDocuments,
  createPythonConsumerLocks,
  createPythonRequirementsLock,
} from './core/python/consumer-contract.js';
export {
  materializePythonPublication,
  pythonPublicationManifestPath,
} from './core/python/publication-manifest.js';
export { publishPythonGenericArtifacts } from './core/python/generic-publisher.js';
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
export { initialPythonApplicationMinors } from './core/python/application-intent.js';
export {
  assertPythonApplicationRecipeCurrent,
  normalizePythonApplicationRecipe,
  pythonRecipeIncompatibilityReason,
  resolvePythonApplicationRecipe,
} from './core/python/application-recipe.js';
export {
  findMaintainedPythonApplicationRecipe,
  installMaintainedPythonApplicationRecipe,
  installMaintainedPythonApplicationRecipes,
  listMaintainedPythonApplicationRecipes,
} from './core/python/maintained-recipes.js';
export {
  addPythonRuntimeContract,
  createPythonPrerequisiteReport,
} from './core/python/runtime-contract.js';
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
  cpythonDistributionArtifactId,
  cpythonDistributionTargetId,
  selectCpythonDistributions,
} from './core/python/distribution-selection.js';
export {
  cpythonDistributionArtifactsDirectory,
  cpythonDistributionFetchReportPath,
  cpythonDistributionIndexPath,
  cpythonDistributionsDirectory,
  downloadCpythonDistributionBundle,
  normalizeCpythonDistributionBundleIndex,
  readCpythonDistributionBundleIndex,
  verifyCpythonDistributionBundle,
} from './core/python/distribution-bundle.js';
export type {
  CpythonDistributionBundleArtifact,
  CpythonDistributionDownloadAction,
  CpythonDistributionDownloadStatus,
} from './core/python/distribution-bundle.js';
export { discoverCpythonDistributionCandidates } from './core/python/distribution-provider.js';
export {
  cpythonDistributionPublishDryRunReportPath,
  cpythonDistributionPublishReportPath,
  publishCpythonDistributions,
} from './core/python/distribution-publisher.js';
export type { CpythonDistributionPublishAction } from './core/python/distribution-publisher.js';
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
export { mergeGiteaOwnerRequirements, resolveGiteaOwnerTarget } from './core/gitea-owners.js';
export type {
  GiteaOwnerKind,
  GiteaOwnerPurpose,
  GiteaOwnerRequirement,
  GiteaOwnerTarget,
  GiteaOwnerVisibility,
  ResolvedGiteaOwner,
} from './core/gitea-owners.js';
export {
  defaultPythonPublicationProfile,
  normalizePythonPublicationProfile,
  resolvePythonPublicationProfile,
} from './core/python/publication-targets.js';
export type {
  PythonPublicationProfile,
  ResolvedPythonPublicationProfile,
} from './core/python/publication-targets.js';
export type {
  MaterializePythonPublicationOptions,
  PythonGenericPackageCoordinates,
  PythonPublicationApplication,
  PythonPublicationArtifact,
  PythonPublicationDocument,
  PythonPublicationManifest,
} from './core/python/publication-manifest.js';
export { configureGitRewrites } from './core/git-config.js';
export { fetchSeedBundle } from './core/fetcher.js';
export { packageFileName } from './core/files.js';
export { readGitSourceManifestRequirements } from './core/git-manifests.js';
export {
  assumeGiteaRepositoriesExist,
  HttpGiteaClient,
  provisionGiteaOwners,
  provisionGiteaRepositories,
} from './core/gitea.js';
export { fetchGitSources, runGitCommand } from './core/git-fetch.js';
export { readStableTagResolutionIndex } from './core/tag-resolution.js';
export {
  captureBundleState,
  downloadReportSucceeded,
  evaluateDownloadWindowGap,
  normalizeDownloadRunRecord,
  readLastSuccessfulFullDownload,
  writeDownloadRunHistory,
  writePublishRunHistory,
} from './core/run-history.js';
export type {
  DownloadRunRecord,
  DownloadRunScope,
  DownloadRunStatus,
  DownloadWindowGap,
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
export {
  assertNpmSecurityGate,
  defaultNpmSecurityPolicy,
  OsvNpmAdvisoryClient,
  scanNpmBundleSecurity,
  writeNpmSecurityReport,
} from './core/security.js';
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
  createWorkspaceSnapshot,
  defaultWorkspaceGiteaUrl,
  defaultWorkspaceOutputDir,
  defaultWorkspaceSourceRegistry,
  editWorkspaceTarget,
  initWorkspace,
  migrateWorkspaceConfig,
  previewWorkspaceConfigMigration,
  previewWorkspaceMigration,
  readWorkspaceConfig,
  readWorkspaceSecrets,
  removeWorkspaceTarget,
  resolveWorkspacePythonApplication,
  saveWorkspaceGiteaToken,
  selectWorkspaceTargets,
  setWorkspaceTargetPythonResolutionMode,
  workspaceConfigFileName,
  workspaceConfigPath,
  workspaceConfigPythonPublicationBackupFileName,
  workspaceConfigPythonPublicationProfileBackupFileName,
  workspaceConfigV1BackupFileName,
  workspaceConfigV1BackupPath,
  workspaceLegacyPythonSettings,
  workspaceTargetEditableFields,
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
  inspectPackageTarball,
  readPackageManifest,
  TarballInspectionCache,
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
export type {
  ApplyGitSourcesOptions,
  GitApplyProgressEvent,
  GitApplyProgressStatus,
  GitHttpAuth,
} from './core/git-apply.js';
export type { ConfigureGitRewritesOptions } from './core/git-config.js';
export type {
  AssumeGiteaRepositoriesExistOptions,
  GiteaClient,
  GiteaOwnerProvisionAction,
  GiteaOwnerProvisionReport,
  GiteaOwnerProvisionStatus,
  HttpGiteaClientOptions,
  ProvisionGiteaOwnersOptions,
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
  WorkspaceConfigMigrationResult,
  WorkspaceDefaults,
  WorkspaceCpythonDistributionsTarget,
  WorkspaceGitTarget,
  WorkspaceLegacyPythonSettings,
  WorkspaceNpmTarget,
  WorkspacePypiTarget,
  WorkspacePromptBoolean,
  WorkspacePythonWheelTarget,
  WorkspacePythonApplicationTarget,
  WorkspacePythonConfig,
  WorkspacePythonLegacySeedConfig,
  WorkspaceSecrets,
  WorkspaceSnapshot,
  WorkspaceTarget,
  WorkspaceTargetEdit,
  WorkspaceTargetEditableField,
  WorkspaceTargetSnapshot,
  SelectWorkspaceTargetsResult,
} from './core/workspace.js';
export type {
  CpythonDistributionCandidate,
  CpythonDistributionSelection,
  CpythonDistributionTargetSelection,
  SelectedCpythonDistribution,
} from './core/python/distribution-selection.js';
export {
  pythonApplicationIntentForVersionSelector,
  setWorkspacePythonApplicationVersionSelection,
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
  PythonApplicationResolver,
  UvCommandInvocation,
  UvCommandResult,
  UvCommandRunner,
  UvResolveRequest,
  UvResolutionErrorKind,
  UvResolutionEvidence,
} from './core/python/uv-adapter.js';
export type {
  CurrentWorkspacePythonApplicationPlan,
  EnsureWorkspacePythonApplicationPlansOptions,
  EnsureWorkspacePythonApplicationPlansResult,
  WorkspacePythonPlanRequiredReason,
  WorkspacePythonPlanRequirement,
} from './core/python/workspace-plan-preflight.js';
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
  PythonApplicationVersionSelection,
  PythonApplicationVersionSelector,
  PythonRuntimePolicy,
} from './core/python/application-intent.js';
export type {
  PythonApplicationRecipe,
  PythonApplicationRecipeCompatibility,
  PythonApplicationRecipeFeature,
} from './core/python/application-recipe.js';
export type { MaintainedPythonApplicationRecipe } from './core/python/maintained-recipes.js';
export type {
  PythonEnvironmentPlan,
  PythonEnvironmentPlanInput,
  PythonEnvironmentPlanPresentation,
  PythonEnvironmentPlanRecipe,
  PythonLockedPackagePlan,
  PythonPlanWheel,
  PythonPlatformPlan,
  PythonRuntimeContract,
} from './core/python/environment-plan.js';
export type {
  ActivePythonApplicationPlan,
  StoredPythonApplicationPlanManifest,
  StoredPythonPlanEvidence,
  WriteActivePythonApplicationPlanOptions,
} from './core/python/active-plan-store.js';
export type {
  DownloadPythonApplicationPlansOptions,
  PythonApplicationArtifactKind,
  PythonApplicationArtifactReference,
  PythonApplicationBundleArtifact,
  PythonApplicationBundleBranchSize,
  PythonApplicationBundleEntry,
  PythonApplicationBundleIndex,
  PythonApplicationDownloadAction,
  PythonApplicationDownloadProgressEvent,
  PythonApplicationDownloadProgressStatus,
  PythonApplicationDownloadReport,
  PythonApplicationDownloadStatus,
  VerifyPythonApplicationBundleResult,
} from './core/python/application-bundle.js';
export type { PythonPlanDiffReport } from './core/python/plan-diff.js';
export type {
  CreatePythonConsumerBundleDocumentsOptions,
  PythonConsumerBundleDocuments,
  PythonConsumerContract,
  PythonConsumerLock,
  PythonConsumerPlatformContract,
} from './core/python/consumer-contract.js';
export type {
  PublishPythonGenericArtifactsOptions,
  PythonGenericPublishAction,
  PythonGenericPublishAuth,
  PythonGenericPublishReport,
} from './core/python/generic-publisher.js';
export type {
  PythonPublishProgressEvent,
  PythonPublishProgressStatus,
} from './core/python/publish-progress.js';

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
  ProjectPackageManagerEngine,
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
