#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';
import { Command } from 'commander';
import {
  addWorkspaceTarget,
  addPythonRuntimeContract,
  acquireUv,
  applyBundle,
  applyGitSources,
  CachedRegistryClient,
  captureBundleState,
  clearWorkspaceGiteaToken,
  collectBundle,
  compareMachineToPythonEnvironmentPlan,
  cpythonDistributionIndexPath,
  downloadPythonApplicationPlans,
  downloadCpythonDistributionBundle,
  ensureWorkspacePythonApplicationPlans,
  evaluateDownloadWindowGap,
  configureGitRewrites,
  createPythonEnvironmentPlan,
  createNpmSecurityDeltaReport,
  createPythonSecurityDeltaReport,
  createGitSourcesManifest,
  createBundleDocuments,
  createFetchReport,
  createWorkspaceGitSources,
  createWorkspaceSnapshot,
  defaultPythonPublicationProfile,
  defaultGiteaNpmOwner,
  defaultNpmRegistryTarget,
  defaultVerdaccioRegistryUrl,
  defaultNpmSecurityPolicy,
  defaultWorkspaceGiteaUrl,
  defaultWorkspaceOutputDir,
  defaultWorkspaceSourceRegistry,
  editWorkspaceTarget,
  fetchGitSources,
  fetchSeedBundle,
  findMaintainedPythonApplicationRecipe,
  formatPythonApplicationCoverageLine,
  explainPlatformCoveragePolicy,
  getBuiltInPlatformFamily,
  HttpGiteaClient,
  HttpRegistryClient,
  HttpPythonIndexClient,
  initWorkspace,
  initialPythonApplicationMinors,
  isGiteaNpmRegistryUrl,
  installMaintainedPythonApplicationRecipe,
  listBuiltInPlatformFamilies,
  migrateWorkspaceConfig,
  MemoizedPythonIndexClient,
  normalizeMachineProbeFacts,
  normalizePythonApplicationRecipe,
  npmSecurityDeltaReportFileName,
  OsvBatchClient,
  OsvNpmAdvisoryClient,
  OsvPythonAdvisoryClient,
  packageName,
  packageVersion,
  parseRootSpecs,
  planPythonApplication,
  pythonApplicationIntentForVersionSelector,
  pythonApplicationSelectorId,
  pythonApplicationVariantId,
  pythonSecurityDeltaReportFileName,
  PythonApplicationPlanningError,
  previewWorkspaceMigration,
  probeMachine,
  pruneInactivePythonApplicationPlans,
  publishBundle,
  scanNpmBundleSecurity,
  scanPythonBundleSecurity,
  summarizeNpmSecurityReport,
  summarizePythonSecurityReport,
  TarballInspectionCache,
  pruneBundle,
  readBundleInfo,
  readFetchReport,
  readGitSourcesManifest,
  readManifestRequirements,
  readPythonApplicationBundleIndex,
  readLastSuccessfulFullDownload,
  readBundleManifest,
  readDistTagsManifest,
  readRegistryMetadataCache,
  readStableTagResolutionIndex,
  readTarballInspectionCache,
  readWorkspaceConfig,
  readWorkspaceSecrets,
  removeWorkspaceTarget,
  resolveNpmRegistryTarget,
  resolveWorkspacePythonApplication,
  saveWorkspaceGiteaToken,
  selectWorkspaceTargets,
  setWorkspacePythonApplicationVersionSelection,
  updateRepositories,
  UvApplicationResolver,
  verifyBundle,
  verifyInstall,
  writeBundleDocuments,
  writeActivePythonApplicationPlan,
  writeCollectReport,
  writeFetchReport,
  writeGiteaRepositoryProvisionReport,
  writeGitApplyReport,
  writeGitConfigReport,
  writeGitFetchReport,
  writeGitSourcesManifest,
  writeRegistryMetadataCache,
  writeTarballInspectionCache,
  writeNpmSecurityReport,
  writeNpmSecurityDeltaReport,
  writePythonSecurityReport,
  writePythonSecurityDeltaReport,
  writePublishReport,
  writePruneReport,
  writeWorkspaceSnapshot,
  writeWorkspaceConfig,
  writeDownloadRunHistory,
  writePublishRunHistory,
  formatPythonPlanDiff,
  workspaceSecretsFileName,
  workspaceConfigFileName,
  workspacePythonPlannerVersion,
  workspaceTargetEditableFields,
  provisionGiteaRepositories,
} from './index.js';
import type { GiteaClient } from './index.js';
import type {
  ApplyProgressEvent,
  ApplyProgressPhase,
  ApplyBundleReport,
  BundleStateSnapshot,
  BundleInfo,
  BundlePruneReport,
  CollectReport,
  CollectProgressEvent,
  DownloadRunRecord,
  FetchSeedBundleResult,
  GitFetchProgressEvent,
  GitApplyProgressEvent,
  GitOwnerStrategy,
  GitPublishOwnerKind,
  LatestPolicy,
  NpmSecurityDeltaReport,
  NpmRegistryTarget,
  PlatformCoveragePolicy,
  PythonApplicationDownloadProgressEvent,
  PythonSecurityDeltaReport,
  PublishProgressEvent,
  PublishProgressPhase,
  RangeResolutionPolicy,
  ResolveRootRequirementsResult,
  TagResolutionPolicy,
  VerifyReport,
  VerifyInstallReport,
  VulnerabilityResolutionPolicy,
  WorkspaceConfig,
  WorkspacePromptBoolean,
  PythonEnvironmentPlanInput,
  PythonApplicationRecipe,
  PythonApplicationVersionSelection,
  PythonEnvironmentPlan,
  PythonPublicationProfile,
  PythonRuntimePolicy,
  WorkspacePythonApplicationTarget,
  WorkspaceTargetEdit,
} from './index.js';
import { validatePythonIndexUrl } from './menu/python-settings.js';
import { validateDownloadInvocation } from './cli-validation.js';
import { formatElapsedTime } from './cli-timing.js';

const defaultDistTagConcurrency = 4;
const defaultPublishConcurrency = 4;
const defaultPythonSourceIndex = 'https://pypi.org/simple/';

function printTotalElapsedTime(startedAt: number, jsonOutput: boolean): void {
  const line = `Total elapsed time: ${formatElapsedTime(performance.now() - startedAt)}`;
  if (jsonOutput) {
    console.error(line);
  } else {
    console.log(line);
  }
}

interface FetchOptions {
  allowPackage?: string[];
  concurrency: number;
  dryRun?: boolean;
  includeDev?: boolean;
  includePeer?: boolean;
  latestPolicy?: LatestPolicy;
  manifest?: string;
  maxSecurityReportAgeHours?: number;
  minReleaseAgeDays?: number;
  output: string;
  rangeResolutionPolicy?: RangeResolutionPolicy;
  registry: string;
  registryTimeoutMs?: number;
  retryDelaysMs?: number[];
  tagResolutionPolicy?: TagResolutionPolicy;
  tarballTimeoutMs?: number;
  vulnerabilityResolutionPolicy?: VulnerabilityResolutionPolicy;
}

interface PublishOptions {
  distTagConcurrency: number;
  dryRun?: boolean;
  giteaToken?: string;
  publishConcurrency: number;
  registry: string;
  registryType?: string;
  skipExisting?: boolean;
}

interface ApplyOptions {
  configureGitGlobal?: boolean;
  distTagConcurrency: number;
  dryRun?: boolean;
  gitea?: string;
  giteaToken?: string;
  gitPassword?: string;
  gitInitialImport?: string;
  gitConcurrency: number;
  gitMigrationAdvertisedHost?: string;
  gitMigrationListenHost?: string;
  gitMigrationPort?: number;
  gitOwnerStrategy?: GitOwnerStrategy;
  gitPublishOwner?: string;
  gitPublishOwnerKind?: GitPublishOwnerKind;
  gitUsername?: string;
  json?: boolean;
  mirrorsDir?: string;
  npmOwner?: string;
  npmRegistryType?: string;
  publishConcurrency: number;
  public?: boolean;
  pythonOwner?: string;
  registry?: string;
  skipExisting?: boolean;
  skipGitProvision?: boolean;
}

interface VerifyOptions {
  json?: boolean;
}

interface VerifyInstallOptions {
  gitea: string;
  giteaToken?: string;
  json?: boolean;
  keepTemp?: boolean;
  registry: string;
  runScripts?: boolean;
  timeoutMs: number;
}

interface CollectOptions {
  allowWindowGap?: boolean;
  allowPackage?: string[];
  concurrency: number;
  dryRun?: boolean;
  includeDev?: boolean;
  includePeer?: boolean;
  json?: boolean;
  latestPolicy?: LatestPolicy;
  maxSecurityReportAgeHours?: number;
  minReleaseAgeDays?: number;
  output?: string;
  prune?: boolean;
  rangeResolutionPolicy?: RangeResolutionPolicy;
  registry?: string;
  registryTimeoutMs?: number;
  retryDelaysMs?: number[];
  tagResolutionPolicy?: TagResolutionPolicy;
  target?: number[];
  tarballTimeoutMs?: number;
  vulnerabilityResolutionPolicy?: VulnerabilityResolutionPolicy;
}

interface BundlePruneOptions {
  dryRun?: boolean;
  json?: boolean;
}

interface InitOptions {
  force?: boolean;
}

interface TargetGitOptions {
  branch?: string;
}

interface TargetPythonApplicationOptions {
  coverage?: string;
  extra?: string[];
  feature?: string[];
  includeVersion?: string[];
  platform?: string[];
  python?: string;
  pythonVersion?: string[];
  recipe?: string;
  version?: string;
}

interface TargetCpythonDistributionsOptions {
  fromMinor: string;
  latest: number;
  platform: string[];
  windowDays: number;
}

interface TargetEditOptions {
  branch?: string;
  clearBranch?: boolean;
  coverage?: string;
  fromMinor?: string;
  includeVersion?: string[];
  inheritCoverage?: boolean;
  inheritPython?: boolean;
  latest?: number;
  platform?: string[];
  python?: string;
  pythonVersion?: string[];
  windowDays?: number;
}

interface GitSourcesOptions {
  write?: boolean;
}

interface MenuOptions {
  once?: boolean;
}

interface CoverageOptions {
  json?: boolean;
}

interface ProbeOptions {
  capability: string[];
  compare: string;
  facts?: string;
  json?: boolean;
}

interface PlanOptions {
  cutoff?: string;
  json?: boolean;
  retryDelaysMs?: number[];
  update?: string;
  uvBin?: string;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got: ${value}`);
  }
  return parsed;
}

function parseRetryDelaysMs(value: string): number[] {
  const delays = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parsePositiveInteger);

  if (delays.length === 0) {
    throw new Error(`Expected at least one retry delay, got: ${value}`);
  }

  return delays;
}

function collectNumbers(value: string, previous: number[]): number[] {
  return [...previous, parsePositiveInteger(value)];
}

function collectStrings(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectOptionalStrings(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function parseCapabilities(values: string[]): Record<string, string> {
  const capabilities: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1 || separator === value.length - 1) {
      throw new Error(`Expected capability in name=value form, got: ${value}`);
    }
    const name = value.slice(0, separator).trim();
    const capabilityValue = value.slice(separator + 1).trim();
    if (!name || !capabilityValue) {
      throw new Error(`Expected capability in name=value form, got: ${value}`);
    }
    capabilities[name] = capabilityValue;
  }
  return capabilities;
}

function parsePythonApplicationPlatforms(values: string[]): PlatformCoveragePolicy['platforms'] {
  if (values.length === 0) {
    throw new Error('At least one --platform value is required');
  }
  return [...new Set(values.map((value) => value.trim()))].map((value) => {
    const family = getBuiltInPlatformFamily(value);
    if (!family) {
      throw new Error(
        `Unsupported platform family: ${value}. Available: ${listBuiltInPlatformFamilies()
          .map((candidate) => candidate.id)
          .join(', ')}`
      );
    }
    return family.id as PlatformCoveragePolicy['platforms'][number];
  });
}

function parseLatestPolicy(value: string): LatestPolicy {
  if (value === 'bundled' || value === 'source') {
    return value;
  }

  throw new Error(`Expected latest policy to be "bundled" or "source"; got: ${value}`);
}

function parseTagResolutionPolicy(value: string): TagResolutionPolicy {
  if (value === 'refresh' || value === 'reuse-stable') {
    return value;
  }

  throw new Error(
    `Expected tag resolution policy to be "refresh" or "reuse-stable"; got: ${value}`
  );
}

function parseRangeResolutionPolicy(value: string): RangeResolutionPolicy {
  if (value === 'refresh' || value === 'reuse-stable') {
    return value;
  }

  throw new Error(
    `Expected range resolution policy to be "refresh" or "reuse-stable"; got: ${value}`
  );
}

function parseVulnerabilityResolutionPolicy(value: string): VulnerabilityResolutionPolicy {
  if (value === 'prefer-clean' || value === 'report-only') {
    return value;
  }

  throw new Error(
    `Expected vulnerability resolution policy to be "prefer-clean" or "report-only"; got: ${value}`
  );
}

function addNpmPublishOptions(command: Command): Command {
  return command
    .option('--no-skip-existing', 'Attempt to publish npm versions that already exist')
    .option(
      '--dist-tag-concurrency <count>',
      'Concurrent npm dist-tag operations',
      parsePositiveInteger,
      defaultDistTagConcurrency
    )
    .option(
      '--publish-concurrency <count>',
      'Concurrent npm tarball validation and publish operations',
      parsePositiveInteger,
      defaultPublishConcurrency
    );
}

function compactArgs(args: (string | undefined)[]): string[] {
  return args.filter((arg): arg is string => arg !== undefined && arg.length > 0);
}

function parsePythonApplicationVersionSelection(
  versions: string[]
): PythonApplicationVersionSelection {
  const selectors = versions
    .map((version) => version.trim())
    .filter(Boolean)
    .map((version) =>
      version.toLowerCase() === 'latest'
        ? { type: 'latest-compatible' as const }
        : { type: 'exact' as const, version }
    );
  if (selectors.length === 0) {
    throw new Error('At least one exact application version or latest is required');
  }
  return { selectors };
}

async function runSelfCommand(
  args: string[],
  cwd: string,
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<void> {
  const cliPath = process.argv[1];
  if (!cliPath) {
    throw new Error('Cannot locate current CLI entrypoint');
  }

  console.error(`[menu] running: airgap-sync ${args.join(' ')}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...envOverrides },
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        console.error('[menu] command finished');
        resolve();
        return;
      }

      reject(
        new Error(`Command failed with exit code ${String(code)}: airgap-sync ${args.join(' ')}`)
      );
    });
  });
}

function collectShouldFail(report: {
  fetch: { errors: unknown[] };
  gitFetch: { errors: unknown[] };
  gitManifestScanErrors: unknown[];
  gitSources: { skipped: unknown[] };
  maxIterationsReached: boolean;
  pythonApplications?: { errors: unknown[] };
  cpythonDistributions?: { errors: unknown[] };
  repositoryUpdate: { errors: unknown[] };
  security?: { ok: boolean };
  pythonSecurity?: { ok: boolean };
}): boolean {
  return (
    report.repositoryUpdate.errors.length > 0 ||
    report.fetch.errors.length > 0 ||
    (report.pythonApplications?.errors.length ?? 0) > 0 ||
    (report.cpythonDistributions?.errors.length ?? 0) > 0 ||
    report.gitSources.skipped.length > 0 ||
    report.gitFetch.errors.length > 0 ||
    report.gitManifestScanErrors.length > 0 ||
    report.maxIterationsReached ||
    report.security?.ok === false ||
    report.pythonSecurity?.ok === false
  );
}

function useColor(): boolean {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

function color(text: string, code: number): string {
  return useColor() ? `\u001B[${String(code)}m${text}\u001B[0m` : text;
}

function green(text: string): string {
  return color(text, 32);
}

function red(text: string): string {
  return color(text, 31);
}

function yellow(text: string): string {
  return color(text, 33);
}

function safeConsoleDetail(value: string, maxLength = 500): string {
  const singleLine = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

interface DownloadSecurityDeltas {
  npm?: NpmSecurityDeltaReport;
  python?: PythonSecurityDeltaReport;
}

async function createDownloadSecurityDeltas(
  outputDir: string,
  report: CollectReport,
  before: BundleStateSnapshot | undefined
): Promise<DownloadSecurityDeltas> {
  const deltas: DownloadSecurityDeltas = {
    ...(report.security
      ? {
          npm: createNpmSecurityDeltaReport(report.security, before?.npmSecurityReport),
        }
      : {}),
    ...(report.pythonSecurity
      ? {
          python: createPythonSecurityDeltaReport(
            report.pythonSecurity,
            before?.pythonSecurityReport
          ),
        }
      : {}),
  };
  await Promise.all([
    ...(deltas.npm ? [writeNpmSecurityDeltaReport(outputDir, deltas.npm)] : []),
    ...(deltas.python ? [writePythonSecurityDeltaReport(outputDir, deltas.python)] : []),
  ]);
  return deltas;
}

function securityDeltaSuffix(
  delta: NpmSecurityDeltaReport | PythonSecurityDeltaReport | undefined
) {
  if (!delta) return 'change comparison unavailable';
  if (delta.comparison.status === 'baseline-created') return 'security baseline created';
  if (delta.comparison.status === 'unavailable') return 'change comparison unavailable';
  return `${String(delta.summary.added)} new ${delta.summary.added === 1 ? 'finding' : 'findings'}`;
}

function formatNpmSecurityDeltaLines(bundleDir: string, delta: NpmSecurityDeltaReport): string[] {
  const lines: string[] = [];
  if (delta.comparison.status === 'baseline-created') {
    lines.push(`NPM security changes: baseline created; review the complete security report once.`);
  } else if (delta.comparison.status === 'unavailable') {
    lines.push(
      `NPM security changes: comparison unavailable (${delta.comparison.reason === 'current-scan-incomplete' ? 'the current scan is incomplete' : 'there is no successful baseline'}).`
    );
  } else {
    const addedDetails = [
      ...delta.advisories.added.map(
        (finding) =>
          `New vulnerability [${finding.name}@${finding.version}] ${finding.id}${finding.summary ? `: ${finding.summary}` : ''}`
      ),
      ...delta.lifecycleScripts.added.map(
        (finding) =>
          `New lifecycle script [${finding.name}@${finding.version}] ${finding.field}: ${finding.value} (approval: ${finding.name}@${finding.version}#sha256:${finding.sha256})`
      ),
    ];
    if (delta.summary.added > 0) {
      lines.push(
        yellow(
          `NPM security WARNING: ${String(delta.summary.added)} new ${delta.summary.added === 1 ? 'finding' : 'findings'} since the previous successful scan (${String(delta.advisories.added.length)} vulnerabilities, ${String(delta.lifecycleScripts.added.length)} lifecycle scripts).`
        ),
        ...addedDetails
          .slice(0, 20)
          .map((detail) => yellow(`NPM security WARNING: ${safeConsoleDetail(detail)}`))
      );
      if (addedDetails.length > 20) {
        lines.push(
          yellow(
            `NPM security: ${String(addedDetails.length - 20)} more new findings omitted from console output.`
          )
        );
      }
      if (delta.advisories.added.length > 0) {
        lines.push(
          `NPM security action: ask the application owner to update the dependency or lockfile, then rerun download.`
        );
      }
      if (delta.lifecycleScripts.added.length > 0) {
        lines.push(
          `NPM security action: review new lifecycle commands; if expected, add the exact approval identity to npmSecurity.allowPackages.`
        );
      }
    }
    if (delta.summary.removed > 0) {
      lines.push(
        `NPM security changes: ${String(delta.summary.removed)} findings resolved since the previous successful scan.`
      );
    }
  }
  lines.push(`NPM security delta: ${path.join(bundleDir, npmSecurityDeltaReportFileName)}`);
  return lines;
}

function formatPythonSecurityDeltaLines(
  bundleDir: string,
  delta: PythonSecurityDeltaReport
): string[] {
  const lines: string[] = [];
  if (delta.comparison.status === 'baseline-created') {
    lines.push(
      `Python security changes: baseline created; review the complete security report once.`
    );
  } else if (delta.comparison.status === 'unavailable') {
    lines.push(
      `Python security changes: comparison unavailable (${delta.comparison.reason === 'current-scan-incomplete' ? 'the current scan is incomplete' : 'there is no successful baseline'}).`
    );
  } else {
    if (delta.summary.added > 0) {
      lines.push(
        yellow(
          `Python security WARNING: ${String(delta.summary.added)} new ${delta.summary.added === 1 ? 'vulnerability' : 'vulnerabilities'} since the previous successful scan.`
        ),
        ...delta.advisories.added
          .slice(0, 20)
          .map((finding) =>
            yellow(
              `Python security WARNING: ${safeConsoleDetail(`New vulnerability [${finding.name}==${finding.version}] ${finding.id}${finding.summary ? `: ${finding.summary}` : ''}`)}`
            )
          ),
        `Python security action: ask the application owner to update the dependency or lockfile, then rerun download.`
      );
      if (delta.advisories.added.length > 20) {
        lines.push(
          yellow(
            `Python security: ${String(delta.advisories.added.length - 20)} more new findings omitted from console output.`
          )
        );
      }
    }
    if (delta.summary.removed > 0) {
      lines.push(
        `Python security changes: ${String(delta.summary.removed)} findings resolved since the previous successful scan.`
      );
    }
  }
  lines.push(`Python security delta: ${path.join(bundleDir, pythonSecurityDeltaReportFileName)}`);
  return lines;
}

function formatDownloadSummary(
  report: CollectReport,
  securityDeltas: DownloadSecurityDeltas = {}
): string {
  const failed = collectShouldFail(report);
  const gitSkipped = report.gitSources.skipped.length;
  const unsupported = report.fetch.unsupported.length;
  const npmErrors = report.fetch.errors.length;
  const npmResolutionWarnings = report.fetch.warnings ?? [];
  const pythonApplicationErrors =
    report.pythonApplications?.errors.filter(
      (error) => error.id !== 'python-security' || report.pythonSecurity?.ok !== false
    ).length ?? 0;
  const cpythonDistributionErrors = report.cpythonDistributions?.errors.length ?? 0;
  const gitErrors =
    report.repositoryUpdate.errors.length +
    report.gitFetch.errors.length +
    report.gitManifestScanErrors.length;
  const securitySummary = report.security
    ? summarizeNpmSecurityReport(report.security, { maxDetails: 20 })
    : undefined;
  const securityErrors =
    report.security?.ok === false ? Math.max(1, securitySummary?.blocking ?? 0) : 0;
  const pythonSecuritySummary = report.pythonSecurity
    ? summarizePythonSecurityReport(report.pythonSecurity, { maxDetails: 20 })
    : undefined;
  const pythonSecurityErrors =
    report.pythonSecurity?.ok === false ? Math.max(1, pythonSecuritySummary?.blocking ?? 0) : 0;
  const totalErrors =
    npmErrors +
    gitErrors +
    pythonApplicationErrors +
    cpythonDistributionErrors +
    securityErrors +
    pythonSecurityErrors;
  const status = failed
    ? red(
        `FAILED Download incomplete: ${String(totalErrors)} errors, ${String(unsupported)} unsupported npm specs, ${String(gitSkipped)} skipped git specs.`
      )
    : green('OK Download completed: all resolved packages and Git mirrors are available.');
  const mode = report.dryRun ? 'dry run, ' : '';
  const downloadedThisRun = report.iterations.reduce(
    (total, iteration) => total + iteration.downloaded,
    0
  );
  const alreadyOnDisk = Math.max(0, report.fetch.resolved - downloadedThisRun);
  const changedGitMirrors = report.gitFetch.actions.filter(
    (action) => action.status === 'updated' && action.changed === true
  ).length;
  const newGitCommits = report.gitFetch.actions.reduce(
    (total, action) => total + (action.newCommits ?? 0),
    0
  );
  const unknownGitMirrors = Math.max(
    0,
    report.gitFetch.updated - changedGitMirrors - report.gitFetch.unchanged
  );
  const npmLine = report.dryRun
    ? `NPM packages: ${String(report.fetch.resolved)} resolved successfully, dry run only, ${String(npmErrors)} requirement errors.`
    : `NPM packages: ${String(report.fetch.resolved)} resolved successfully (${String(downloadedThisRun)} downloaded, ${String(alreadyOnDisk)} already on disk), ${String(npmErrors)} requirement errors.`;
  const vulnerabilityResolutionLine = report.fetch.vulnerabilityResolutions?.length
    ? `NPM vulnerability resolution: ${String(report.fetch.vulnerabilityResolutions.length)} vulnerable range selections replaced with OSV-clean compatible versions.`
    : undefined;
  const releaseAgeWarningLine = npmResolutionWarnings.length
    ? yellow(
        `NPM release-age WARNING: ${String(npmResolutionWarnings.length)} exact or otherwise non-substitutable requirements were bundled before meeting the configured minimum release age.`
      )
    : undefined;
  const gitLine = report.dryRun
    ? `Git mirrors: ${String(report.gitFetch.totalRepositories)} total, ${String(report.gitFetch.planned)} planned, ${String(report.gitFetch.errors.length)} errors.`
    : `Git mirrors: ${String(report.gitFetch.totalRepositories)} total, ${String(report.gitFetch.cloned)} cloned, ${String(changedGitMirrors)} changed${newGitCommits > 0 ? `, +${String(newGitCommits)} commits` : ''}, ${String(report.gitFetch.unchanged)} unchanged${unknownGitMirrors > 0 ? `, ${String(unknownGitMirrors)} checked` : ''}, ${String(report.gitFetch.errors.length)} errors.`;
  const pythonApplicationsLine = report.pythonApplications
    ? report.dryRun
      ? `Python applications: ${String(report.pythonApplications.applications.length)} planned, ${String(report.pythonApplications.planned)} artifacts / ${String(report.pythonApplications.incrementalBytes)} incremental bytes, ${String(report.pythonApplications.errors.length)} errors.`
      : `Python applications: ${String(report.pythonApplications.applications.length)} bundled (${String(report.pythonApplications.downloaded)} artifacts downloaded, ${String(report.pythonApplications.existing)} already on disk, ${String(report.pythonApplications.totalBytes)} total bytes / ${String(report.pythonApplications.incrementalBytes)} incremental), ${String(report.pythonApplications.errors.length)} errors.`
    : undefined;
  const pythonApplicationCoverageLine = report.pythonApplications
    ? formatPythonApplicationCoverageLine(report.pythonApplications.applications)
    : undefined;
  const cpythonDistributionsLine = report.cpythonDistributions
    ? report.dryRun
      ? `CPython distributions: ${String(report.cpythonDistributions.selected)} selected, ${String(report.cpythonDistributions.planned)} planned, ${String(report.cpythonDistributions.errors.length)} errors.`
      : `CPython distributions: ${String(report.cpythonDistributions.selected)} selected (${String(report.cpythonDistributions.downloaded)} downloaded, ${String(report.cpythonDistributions.skipped)} already on disk), ${String(report.cpythonDistributions.errors.length)} errors.`
    : undefined;
  const securityLine = report.security
    ? report.security.ok
      ? green(
          `NPM security: ok (${String(report.security.packageCount)} packages scanned, ${String(securitySummary?.warningAdvisories ?? 0)} known vulnerabilities recorded, ${String(securitySummary?.lifecycleScripts ?? 0)} lifecycle scripts recorded, ${String(securitySummary?.approved ?? 0)} approved static findings, ${securityDeltaSuffix(securityDeltas.npm)}).`
        )
      : red(
          `NPM security: FAILED (${String(securitySummary?.blockingAdvisories ?? 0)} blocking advisories, ${String(securitySummary?.blockingStatic ?? 0)} blocked static findings, ${String(securitySummary?.scannerErrors ?? 0)} scanner errors, ${String(securitySummary?.warningAdvisories ?? 0)} known vulnerabilities recorded, ${String(securitySummary?.lifecycleScripts ?? 0)} lifecycle scripts recorded, ${securityDeltaSuffix(securityDeltas.npm)}).`
        )
    : report.dryRun
      ? 'NPM security: not run during dry-run.'
      : yellow('NPM security: not run.');
  const hasPythonPackages = Boolean(report.pythonApplications);
  const pythonSecurityLine = report.pythonSecurity
    ? report.pythonSecurity.ok
      ? green(
          `Python security: ok (${String(report.pythonSecurity.packageCount)} packages scanned, ${String(pythonSecuritySummary?.warnings ?? 0)} known vulnerabilities recorded, ${securityDeltaSuffix(securityDeltas.python)}).`
        )
      : red(
          `Python security: FAILED (${String(pythonSecuritySummary?.blockingAdvisories ?? 0)} blocking advisories, ${String(pythonSecuritySummary?.scannerErrors ?? 0)} scanner errors, ${String(pythonSecuritySummary?.warnings ?? 0)} known vulnerabilities recorded, ${securityDeltaSuffix(securityDeltas.python)}).`
        )
    : hasPythonPackages
      ? report.dryRun
        ? 'Python security: not run during dry-run.'
        : yellow('Python security: not run.')
      : undefined;
  const reportsWritten = report.dryRun ? 'no' : 'yes';
  const bundleUpdated = report.wroteBundle ? 'yes' : 'no';
  const lines = [
    status,
    npmLine,
    ...(releaseAgeWarningLine ? [releaseAgeWarningLine] : []),
    ...(vulnerabilityResolutionLine ? [vulnerabilityResolutionLine] : []),
    securityLine,
    gitLine,
    ...(pythonApplicationsLine ? [pythonApplicationsLine] : []),
    ...(pythonApplicationCoverageLine
      ? [
          pythonApplicationCoverageLine.hasSkippedPythonMinors
            ? yellow(pythonApplicationCoverageLine.text)
            : pythonApplicationCoverageLine.text,
          ...pythonApplicationCoverageLine.warningDetails.map((detail) =>
            yellow(`Python application coverage WARNING: ${safeConsoleDetail(detail)}`)
          ),
        ]
      : []),
    ...(pythonSecurityLine ? [pythonSecurityLine] : []),
    ...(cpythonDistributionsLine ? [cpythonDistributionsLine] : []),
    `Bundle: ${report.outputDir} (${mode}bundle updated: ${bundleUpdated}, reports written: ${reportsWritten}).`,
  ];

  if (npmResolutionWarnings.length > 0) {
    lines.push(
      ...npmResolutionWarnings
        .slice(0, 20)
        .map((warning) =>
          yellow(
            `NPM release-age WARNING [${warning.name}@${warning.version}, required by ${warning.requiredBy}]: ${safeConsoleDetail(warning.reason)}`
          )
        )
    );
    if (npmResolutionWarnings.length > 20) {
      lines.push(
        yellow(
          `NPM release-age: ${String(npmResolutionWarnings.length - 20)} more warnings omitted from console output; see fetch-report.json.`
        )
      );
    }
  }

  if (report.fetch.errors.length > 0) {
    lines.push(
      ...report.fetch.errors
        .slice(0, 20)
        .map((error) =>
          red(
            `NPM resolution ERROR [${error.raw}, required by ${error.requiredBy}]: ${safeConsoleDetail(error.reason)}`
          )
        )
    );
    if (report.fetch.errors.length > 20) {
      lines.push(
        red(
          `NPM resolution: ${String(report.fetch.errors.length - 20)} more errors omitted from console output; see fetch-report.json.`
        )
      );
    }
  }

  if (report.security && securitySummary) {
    lines.push(
      ...securitySummary.details.map((detail) => {
        const line = `NPM security ${detail.level.toUpperCase()}: ${safeConsoleDetail(detail.message)}`;
        return detail.level === 'error'
          ? red(line)
          : detail.level === 'warning'
            ? yellow(line)
            : line;
      })
    );
    if (securitySummary.omitted > 0) {
      lines.push(
        yellow(
          `NPM security: ${String(securitySummary.omitted)} more findings omitted from console output.`
        )
      );
    }
    lines.push(
      `NPM security report: ${path.join(
        report.outputDir,
        report.security.ok ? 'security-report.json' : 'security-report.failed.json'
      )}`
    );
    if (securityDeltas.npm) {
      lines.push(...formatNpmSecurityDeltaLines(report.outputDir, securityDeltas.npm));
    }
  }

  if (report.pythonSecurity && pythonSecuritySummary) {
    lines.push(
      ...pythonSecuritySummary.details.map((detail) => {
        const line = `Python security ${detail.level.toUpperCase()}: ${safeConsoleDetail(detail.message)}`;
        return detail.level === 'error' ? red(line) : yellow(line);
      })
    );
    if (pythonSecuritySummary.omitted > 0) {
      lines.push(
        yellow(
          `Python security: ${String(pythonSecuritySummary.omitted)} more findings omitted from console output.`
        )
      );
    }
    lines.push(
      `Python security report: ${path.join(
        report.outputDir,
        report.pythonSecurity.ok
          ? 'python-security-report.json'
          : 'python-security-report.failed.json'
      )}`
    );
    if (securityDeltas.python) {
      lines.push(...formatPythonSecurityDeltaLines(report.outputDir, securityDeltas.python));
    }
  }

  if (report.pythonApplications?.errors.length) {
    lines.push(
      ...report.pythonApplications.errors
        .filter((error) => error.id !== 'python-security' || report.pythonSecurity?.ok !== false)
        .map((error) =>
          red(
            `Python application artifact error [${error.file}]: ${error.error ?? 'unknown error'}`
          )
        )
    );
  }
  if (report.cpythonDistributions?.errors.length) {
    lines.push(
      ...report.cpythonDistributions.errors.map((error) =>
        red(`CPython distribution error [${error.file}]: ${error.error ?? 'unknown error'}`)
      )
    );
  }

  if (unsupported > 0 || gitSkipped > 0 || report.maxIterationsReached) {
    lines.push(
      `Attention: ${String(unsupported)} unsupported npm specs, ${String(gitSkipped)} skipped git specs, max iterations reached: ${String(report.maxIterationsReached)}.`
    );
  }

  return lines.join('\n');
}

function formatPublishSummary(report: ApplyBundleReport, bundle: string): string {
  const npmAuthErrors = report.publish.errors.filter((error) => error.action === 'auth');
  const npmPublishErrors = report.publish.errors.filter((error) => error.action === 'publish');
  const npmTagErrors = report.publish.errors.filter((error) => error.action === 'dist-tag');
  const giteaErrors = report.gitea.errors.length + report.gitea.organizationErrors.length;
  const gitApplyErrors = report.gitApply.errors.length;
  const gitConfigErrors = report.gitConfig?.errors.length ?? 0;
  const pythonErrors = report.python?.errors.length ?? 0;
  const pythonApplicationErrors = report.pythonApplications?.errors.length ?? 0;
  const cpythonDistributionErrors = report.cpythonDistributions?.errors.length ?? 0;
  const totalErrors =
    npmAuthErrors.length +
    npmPublishErrors.length +
    npmTagErrors.length +
    giteaErrors +
    gitApplyErrors +
    gitConfigErrors +
    pythonErrors +
    pythonApplicationErrors +
    cpythonDistributionErrors;
  const mode = report.dryRun ? 'dry run, ' : '';
  const status = report.succeeded
    ? green(
        report.dryRun
          ? 'OK Publish dry run completed: planned npm, Git repository, Git mirror, and Git rewrite actions are available.'
          : 'OK Publish completed: npm, Python, and Git targets are up to date.'
      )
    : red(`FAILED Publish incomplete: ${String(totalErrors)} errors.`);
  const npmPackageAction = report.dryRun ? 'planned' : 'published';
  const npmTagAction = report.dryRun ? 'planned' : 'restored';
  const gitAction = report.dryRun ? 'planned' : 'pushed';
  const lines = [
    status,
    ...(npmAuthErrors.length > 0
      ? [
          red(`NPM auth: failed for ${report.registryUrl}.`),
          ...npmAuthErrors.map((error) => error.error ?? 'Unknown npm authentication error'),
          'Package publishing and dist-tag restore were skipped because registry authentication failed.',
        ]
      : []),
    `NPM packages: ${String(report.publish.totalPackages)} total, ${String(
      report.publish.published
    )} ${npmPackageAction}, ${String(report.publish.skipped)} already in registry, ${String(
      npmPublishErrors.length
    )} errors.`,
    `NPM dist-tags: ${String(report.publish.restoredTags)} ${npmTagAction}, ${String(
      npmTagErrors.length
    )} errors.`,
    ...(report.python
      ? [
          `Python wheels: ${String(report.python.actions.length)} total, ${String(
            report.python.published + report.python.planned
          )} ${report.dryRun ? 'planned' : 'published'}, ${String(
            report.python.skipped
          )} already in registry, ${String(pythonErrors)} errors.`,
          `Python index: ${report.python.indexUrl}`,
        ]
      : []),
    ...(report.pythonApplications
      ? [
          `Python application contracts: ${String(report.pythonApplications.actions.length)} total, ${String(report.pythonApplications.published + report.pythonApplications.planned)} ${report.dryRun ? 'planned' : 'published'}, ${String(report.pythonApplications.skipped)} already in registry, ${String(pythonApplicationErrors)} errors.`,
        ]
      : []),
    ...(report.cpythonDistributions
      ? [
          `CPython distributions: ${String(report.cpythonDistributions.actions.length)} total, ${String(report.cpythonDistributions.published + report.cpythonDistributions.planned)} ${report.dryRun ? 'planned' : 'published'}, ${String(report.cpythonDistributions.skipped)} already in Gitea, ${String(cpythonDistributionErrors)} errors.`,
        ]
      : []),
    report.dryRun
      ? `Git repositories: ${String(report.gitea.totalRepositories)} total, ${String(report.gitea.planned)} planned, ${String(report.gitea.exists)} already existed, ${String(giteaErrors)} errors.`
      : `Git repositories: ${String(report.gitea.totalRepositories)} total, ${String(report.gitea.migrated)} imported, ${String(report.gitea.created)} provisioned for push, ${String(report.gitea.migrationFallbacks.length)} import fallbacks, ${String(report.gitea.exists)} already existed, ${String(giteaErrors)} errors.`,
    `Git mirrors: ${String(report.gitApply.totalRepositories)} total, ${String(
      report.gitApply.pushed + report.gitApply.planned
    )} ${gitAction}, ${String(report.gitApply.missingMirrors)} missing, ${String(
      gitApplyErrors
    )} errors.`,
  ];

  if (report.gitConfig) {
    lines.push(
      `Git rewrites: ${String(report.gitConfig.configured + report.gitConfig.planned)} ${
        report.dryRun ? 'planned' : 'configured'
      }, ${String(gitConfigErrors)} errors.`
    );
  }

  lines.push(
    `Bundle: ${path.resolve(bundle)} (${mode}reports written: yes, registry: ${report.registryUrl}).`
  );

  return lines.join('\n');
}

function formatPruneSummary(report: BundlePruneReport): string {
  const failed = report.errors.length > 0;
  const verb = report.dryRun ? 'planned' : 'removed';
  const status = failed
    ? red(
        `FAILED Bundle prune incomplete: ${String(report.errors.length)} errors, ${String(
          report.planned
        )} stale objects found.`
      )
    : green(
        `OK Bundle prune ${report.dryRun ? 'planned' : 'completed'}: ${String(
          report.planned
        )} stale objects ${verb}.`
      );

  return [
    status,
    `NPM tarballs: ${String(report.npmPackages.total)} total, ${String(
      report.npmPackages.stale
    )} stale, ${String(report.npmPackages.removed)} removed.`,
    `Python wheels: ${String(report.pythonPackages.total)} total, ${String(
      report.pythonPackages.stale
    )} stale, ${String(report.pythonPackages.removed)} removed.`,
    ...(report.pythonApplicationArtifacts
      ? [
          `Python application artifacts: ${String(report.pythonApplicationArtifacts.total)} total, ${String(report.pythonApplicationArtifacts.stale)} stale, ${String(report.pythonApplicationArtifacts.removed)} removed.`,
        ]
      : []),
    ...(report.pythonApplicationArtifactDirectories
      ? [
          `Python application artifact directories: ${String(report.pythonApplicationArtifactDirectories.total)} total, ${String(report.pythonApplicationArtifactDirectories.stale)} stale, ${String(report.pythonApplicationArtifactDirectories.removed)} removed.`,
        ]
      : []),
    ...(report.pythonApplicationPlans
      ? [
          `Python application plans: ${String(report.pythonApplicationPlans.total)} total, ${String(report.pythonApplicationPlans.stale)} stale, ${String(report.pythonApplicationPlans.removed)} removed.`,
        ]
      : []),
    ...(report.cpythonDistributions
      ? [
          `CPython distributions: ${String(report.cpythonDistributions.total)} total, ${String(report.cpythonDistributions.stale)} stale, ${String(report.cpythonDistributions.removed)} removed.`,
        ]
      : []),
    `Git mirrors: ${String(report.gitMirrors.total)} total, ${String(
      report.gitMirrors.stale
    )} stale, ${String(report.gitMirrors.removed)} removed.`,
    `Report: ${report.dryRun ? 'prune-dry-run-report.json' : 'prune-report.json'}.`,
  ].join('\n');
}

async function pruneAfterSuccessfulDownload(
  report: CollectReport
): Promise<BundlePruneReport | undefined> {
  if (report.dryRun || !report.wroteBundle || !report.fixedPoint || collectShouldFail(report)) {
    console.error('[prune] skipped: download did not complete successfully');
    return undefined;
  }

  const pruneReport = await pruneBundle({ bundleDir: report.outputDir });
  await writePruneReport(report.outputDir, pruneReport);
  return pruneReport;
}

async function reportDownloadWatermark(
  bundleDir: string,
  now = new Date()
): Promise<DownloadRunRecord | undefined> {
  const lastSuccessfulDownload = await readLastSuccessfulFullDownload(bundleDir);
  if (!lastSuccessfulDownload) {
    console.error('[download] last successful full download: none recorded');
    return undefined;
  }
  const elapsedMs = Math.max(
    0,
    now.getTime() - new Date(lastSuccessfulDownload.completedAt).getTime()
  );
  const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  console.error(
    `[download] last successful full download: ${lastSuccessfulDownload.completedAt} (${String(elapsedDays)} ${elapsedDays === 1 ? 'day' : 'days'} ago)`
  );
  return lastSuccessfulDownload;
}

async function confirmCpythonWindowGap(options: {
  allowWindowGap?: boolean;
  config: WorkspaceConfig;
  lastSuccessfulDownload: DownloadRunRecord | undefined;
  now?: Date;
  targetIndexes?: number[];
}): Promise<void> {
  if (!options.lastSuccessfulDownload) {
    return;
  }
  const now = options.now ?? new Date();
  const gaps = options.config.targets.flatMap((target, index) => {
    if (target.type !== 'cpython-distributions') {
      return [];
    }
    const gap = evaluateDownloadWindowGap(
      options.lastSuccessfulDownload!,
      target.builds.windowDays,
      now
    );
    return gap.exceedsWindow ? [{ gap, index: options.targetIndexes?.[index] ?? index + 1 }] : [];
  });
  if (gaps.length === 0) {
    return;
  }
  console.error(
    `[download] WARNING: the interval since the last successful full download exceeds the CPython build window for ${gaps
      .map(
        ({ gap, index }) =>
          `target ${String(index)} (${gap.elapsedDays.toFixed(1)} days elapsed, ${String(gap.windowDays)} configured)`
      )
      .join(', ')}.`
  );
  console.error(
    `[download] Increase windowDays to at least ${String(Math.max(...gaps.map(({ gap }) => gap.requiredWindowDays)))} to transfer the gap before narrowing it again.`
  );
  if (options.allowWindowGap === true) {
    console.error('[download] continuing because --allow-window-gap was provided');
    return;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error('CPython build window gap requires --allow-window-gap to continue');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (!(await askYesNo(rl, 'Continue and accept the CPython build window gap?', false))) {
      throw new Error('Download stopped because the CPython build window has a gap');
    }
  } finally {
    rl.close();
  }
}

function formatTargetList(targets: WorkspaceConfig['targets']): string {
  if (targets.length === 0) {
    return 'No targets configured.';
  }

  return targets
    .map((target, index) => {
      const prefix = `${String(index + 1)}.`;
      return `${prefix} ${formatTargetValue(target)}`;
    })
    .join('\n');
}

function formatPythonRuntimePolicy(policy: PythonRuntimePolicy | undefined): string {
  if (!policy) {
    return 'workspace default';
  }
  return policy.policy === 'selected'
    ? policy.versions.join(', ')
    : policy.policy === 'constrained'
      ? policy.version
      : 'auto';
}

function formatTargetValue(target: WorkspaceConfig['targets'][number]): string {
  const value =
    target.type === 'cpython-distributions'
      ? `cpython-distributions ${target.series.from}..${target.series.through}; latest ${String(target.patches.latest)}; ${String(target.builds.windowDays)} days; ${target.platforms.join(', ')}`
      : target.type === 'git'
        ? `git ${target.url}${target.branch ? ` (${target.branch})` : ''}`
        : `${target.type} ${target.spec}`;
  const pythonApplicationRuntime =
    target.type === 'python-app' ? formatPythonRuntimePolicy(target.python) : undefined;
  const pythonApplicationCoverage =
    target.type === 'python-app'
      ? typeof target.coverage === 'string'
        ? target.coverage
        : target.coverage
          ? target.coverage.platforms.join(', ')
          : 'workspace default'
      : undefined;
  const pythonApplicationVersions =
    target.type === 'python-app'
      ? target.application.versionSelection
        ? target.application.versionSelection.selectors
            .map((selector) =>
              selector.type === 'exact'
                ? selector.version
                : selector.constraint
                  ? `latest (${selector.constraint})`
                  : 'latest'
            )
            .join(', ')
        : target.application.version
          ? `latest (${target.application.version})`
          : 'latest'
      : undefined;
  return `${value}${pythonApplicationVersions ? ` [versions: ${pythonApplicationVersions}]` : ''}${pythonApplicationCoverage ? ` [coverage: ${pythonApplicationCoverage}]` : ''}${pythonApplicationRuntime ? ` [python: ${pythonApplicationRuntime}]` : ''}`;
}

function formatWorkspaceConfig(config: WorkspaceConfig): string {
  const defaultCoverageSelection =
    config.python?.applicationDefaults?.coverage ?? config.coveragePolicies?.[0]?.id;
  const defaultCoverage =
    typeof defaultCoverageSelection === 'string'
      ? config.coveragePolicies?.find((policy) => policy.id === defaultCoverageSelection)
      : defaultCoverageSelection;
  const defaultCoverageId =
    typeof defaultCoverageSelection === 'string' ? defaultCoverageSelection : undefined;
  const publication = config.python?.publication ?? defaultPythonPublicationProfile();
  const publicationOwner = (owner: PythonPublicationProfile['owner']): string =>
    owner.strategy === 'authenticated-user' ? 'authenticated user' : `${owner.kind} ${owner.name}`;
  const npmRegistry = config.npmRegistry;
  const npmRegistryDescription = !npmRegistry
    ? '(not set)'
    : npmRegistry.type === 'verdaccio'
      ? `verdaccio ${npmRegistry.url}`
      : `gitea ${publicationOwner(npmRegistry.owner)}`;
  const pythonLines = [
    `Python application source: ${config.python?.sourceIndex ?? defaultPythonSourceIndex}`,
    `Python publication owner: ${publicationOwner(publication.owner)}`,
    `Python PyPI owner: ${publicationOwner(publication.pypiOwner ?? publication.owner)}`,
    ...(publication.publishEvidence === true
      ? [
          `Python Generic evidence owner: ${publicationOwner(publication.genericOwner ?? publication.owner)}`,
        ]
      : []),
    `Default application coverage: ${
      defaultCoverage
        ? `${defaultCoverageId ? `${defaultCoverageId} ` : ''}(${defaultCoverage.platforms.join(', ')})`
        : '(not set)'
    }`,
    `Default Python runtime: ${formatPythonRuntimePolicy(config.python?.applicationDefaults?.runtime)}`,
    `Python planner: ${config.python?.planner.engine ?? 'uv'} ${config.python?.planner.version ?? '(not set)'}`,
  ];
  return [
    `Bundle directory: ${config.output}`,
    `Source registry: ${config.sourceRegistry}`,
    `npm release quarantine: ${String(config.npmSecurity?.minReleaseAgeDays ?? defaultNpmSecurityPolicy.minReleaseAgeDays)} days`,
    `npm security report TTL: ${String(config.npmSecurity?.maxReportAgeHours ?? defaultNpmSecurityPolicy.maxReportAgeHours)} hours`,
    `npm vulnerability resolution: ${config.npmSecurity?.vulnerabilityResolutionPolicy ?? defaultNpmSecurityPolicy.vulnerabilityResolutionPolicy}`,
    `Target npm registry: ${npmRegistryDescription}`,
    `Gitea URL: ${config.giteaUrl ?? '(not set)'}`,
    ...pythonLines,
    `Download devDependencies: ${promptBooleanToString(config.defaults.download.includeDev)}`,
    `Download peerDependencies: ${promptBooleanToString(config.defaults.download.includePeer)}`,
    `Latest policy: ${config.defaults.download.latestPolicy}`,
    `Range resolution policy: ${config.defaults.download.rangeResolutionPolicy}`,
    `Tag resolution policy: ${config.defaults.download.tagResolutionPolicy}`,
    `Prune stale bundle objects: ${promptBooleanToString(config.defaults.download.prune)}`,
    `Provision Git repositories: ${promptBooleanToString(config.defaults.publish.provisionGit)}`,
    `Publish public repositories: ${promptBooleanToString(config.defaults.publish.publicRepositories)}`,
    `Configure global Git rewrites: ${promptBooleanToString(config.defaults.publish.configureGitGlobal)}`,
    `Verify install ignore scripts: ${promptBooleanToString(config.defaults.verifyInstall.ignoreScripts)}`,
    '',
    'Targets:',
    formatTargetList(config.targets),
  ].join('\n');
}

function findCoveragePolicy(config: WorkspaceConfig, id: string): PlatformCoveragePolicy {
  const policy = config.coveragePolicies?.find((candidate) => candidate.id === id);
  if (policy) {
    return policy;
  }
  const family = getBuiltInPlatformFamily(id);
  if (family) {
    return {
      id: family.id,
      platforms: [family.id as PlatformCoveragePolicy['platforms'][number]],
      version: 1,
      wheelStrategy: 'minimum-cover',
    };
  }
  throw new Error(`Unknown coverage policy or platform family: ${id}`);
}

function formatCoverageExplanation(policy: PlatformCoveragePolicy): string {
  const explanation = explainPlatformCoveragePolicy(policy);
  const lines = [`Coverage: ${policy.id}`, `Wheel strategy: ${policy.wheelStrategy}`];
  for (const platform of explanation.platforms) {
    lines.push(`${platform.family.id}: ${platform.family.os}/${platform.family.architecture}`);
    if (platform.glibc?.source === 'inferred-during-planning') {
      lines.push('  glibc minimum: inferred from the resolved wheel closure');
    } else if (platform.glibc?.source === 'advanced-constraint') {
      lines.push(`  glibc minimum: ${platform.glibc.minimum}`);
      const compatible = platform.glibc.knownCompatibleExamples
        .map((hint) => `${hint.aliases[0] ?? hint.distributionId} ${hint.release}`)
        .join(', ');
      const incompatible = platform.glibc.knownIncompatibleExamples
        .map((hint) => `${hint.aliases[0] ?? hint.distributionId} ${hint.release}`)
        .join(', ');
      if (compatible) {
        lines.push(`  known compatible examples: ${compatible}`);
      }
      if (incompatible) {
        lines.push(`  known incompatible examples: ${incompatible}`);
      }
    }
  }
  lines.push(
    `Distribution hints: ${explanation.catalog.version}, reviewed ${explanation.catalog.lastReviewedAt}`
  );
  return lines.join('\n');
}

function formatProbeComparison(
  comparison: ReturnType<typeof compareMachineToPythonEnvironmentPlan>
): string {
  return [
    `Probe status: ${comparison.status}`,
    `Detected: ${comparison.facts.os}/${comparison.facts.architecture}`,
    ...comparison.checks.map(
      (check) =>
        `${check.status.toUpperCase()} ${check.name}: ${check.message}${
          check.actual ? ` (actual: ${check.actual})` : ''
        }${check.required ? ` (required: ${check.required})` : ''}`
    ),
  ].join('\n');
}

function formatPythonApplicationPlan(plan: PythonEnvironmentPlan): string {
  const packageCount = new Set(
    plan.platforms.flatMap((platform) =>
      platform.packages.map((item) => `${item.name}==${item.version}`)
    )
  ).size;
  const explanation = explainPlatformCoveragePolicy(plan.coverage.policy);
  const platformLines = plan.platforms.flatMap((platform) => {
    const baseHints = explanation.platforms.find(
      (candidate) => candidate.family.id === platform.platformFamilyId
    );
    const inferredExplanation = platform.supportBoundary?.glibc
      ? explainPlatformCoveragePolicy({
          ...plan.coverage.policy,
          linux: { oldestSupportedGlibc: platform.supportBoundary.glibc },
        })
      : undefined;
    const hints =
      inferredExplanation?.platforms.find(
        (candidate) => candidate.family.id === platform.platformFamilyId
      ) ?? baseHints;
    const examples =
      hints?.glibc?.source === 'advanced-constraint'
        ? hints.glibc.knownCompatibleExamples
            .slice(0, 2)
            .map((hint) => `${hint.aliases[0] ?? hint.distributionId} ${hint.release}`)
            .join(', ')
        : undefined;
    return [
      `${platform.platformFamilyId}: ${platform.status}, CPython ${platform.pythonMinor}${
        platform.supportBoundary?.glibc ? `, glibc >= ${platform.supportBoundary.glibc}` : ''
      }`,
      ...(examples ? [`  compatible distribution examples: ${examples}`] : []),
    ];
  });
  const skippedPythonLines = (plan.presentation?.skippedPythonMinors ?? []).map(
    (skipped) =>
      `Skipped CPython ${skipped.pythonMinor}: ${skipped.reasons.join('; ') || 'no complete dependency tree'}`
  );
  return [
    `Application: ${plan.application.name} ${plan.application.version}`,
    `Runtime contract: externally provisioned CPython ${plan.preferredPythonMinor ?? 'per platform'}`,
    ...platformLines,
    ...skippedPythonLines,
    `Locked packages: ${String(packageCount)}`,
    `Wheel variants: ${String(plan.wheels.length)}`,
    'Publication: resolved on the closed-network side',
    'Status: ready to download',
  ].join('\n');
}

function formatPythonPlanningError(error: PythonApplicationPlanningError): string {
  const branches = error.rejectedCandidates.slice(0, 8).map((rejection) => {
    const kind = rejection.reason.startsWith('application-incompatible: ')
      ? rejection.reason.slice('application-incompatible: '.length)
      : rejection.reason.startsWith('recipe-incompatible: ')
        ? rejection.reason.slice('recipe-incompatible: '.length)
        : rejection.reason.includes('no-wheel')
          ? 'required binary wheels are unavailable'
          : rejection.reason.includes('no-solution')
            ? 'dependencies have no compatible solution'
            : rejection.reason.includes('tool-failure')
              ? 'the pinned planner failed'
              : 'this application/runtime combination is unsupported';
    return `- ${rejection.platformFamilyId ?? 'requested coverage'}, Python ${rejection.pythonMinor}, application ${rejection.applicationVersion}: ${kind}`;
  });
  return [
    `Error: requested Python application coverage is incomplete. ${error.message}`,
    ...branches,
    ...(error.rejectedCandidates.length > branches.length
      ? [`- ${String(error.rejectedCandidates.length - branches.length)} more rejected branches`]
      : []),
    'Try one of: remove an unsupported platform from this target, select an older application version, or supply a maintained recipe/wheel for the missing branch.',
  ].join('\n');
}

function printPythonPlanningError(error: PythonApplicationPlanningError, json = false): void {
  console.error(
    json
      ? JSON.stringify(
          {
            error: error.message,
            rejectedCandidates: error.rejectedCandidates,
            status: 'unsupported-coverage',
          },
          null,
          2
        )
      : formatPythonPlanningError(error)
  );
}

async function readWorkspacePythonRecipe(
  workspaceDir: string,
  target: WorkspacePythonApplicationTarget
): Promise<PythonApplicationRecipe | undefined> {
  if (!target.application.recipe) {
    return undefined;
  }
  const workspaceRoot = path.resolve(workspaceDir);
  const recipePath = path.resolve(workspaceRoot, target.application.recipe);
  if (recipePath !== workspaceRoot && !recipePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error('python-app recipe must be inside the workspace');
  }
  try {
    return normalizePythonApplicationRecipe(JSON.parse(await readFile(recipePath, 'utf8')));
  } catch (error) {
    throw new Error(`Invalid Python application recipe ${recipePath}: ${(error as Error).message}`);
  }
}

interface PlanWorkspacePythonApplicationsOptions {
  config: WorkspaceConfig;
  cutoff?: string;
  retryDelaysMs?: number[];
  targetIndexes?: number[];
  uvBin?: string;
  workspaceDir: string;
}

async function planWorkspacePythonApplications(options: PlanWorkspacePythonApplicationsOptions) {
  const selectedIndexes = options.targetIndexes ? new Set(options.targetIndexes) : undefined;
  const targets = options.config.targets.flatMap((target, index) =>
    target.type === 'python-app' && (!selectedIndexes || selectedIndexes.has(index + 1))
      ? [{ index: index + 1, target }]
      : []
  );
  if (targets.length === 0) {
    throw new Error('No python-app targets are selected');
  }
  const cutoff = options.cutoff ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(cutoff))) {
    throw new Error(`Invalid planning cutoff: ${cutoff}`);
  }
  const createdAt = new Date().toISOString();
  const configuredUv = options.uvBin ?? process.env.UV_BIN;
  const uvPath = await acquireUv({
    cacheDir: path.join(options.workspaceDir, '.airgap-sync', 'tool-cache'),
    onDownloadStart: ({ downloadedBytes, size, url, version }) => {
      console.error(
        downloadedBytes > 0
          ? `[python-plan] resuming pinned uv ${version} at ${formatProgressBytes(downloadedBytes)}/${formatProgressBytes(size)}: ${url}`
          : `[python-plan] downloading pinned uv ${version} (${formatProgressBytes(size)}): ${url}`
      );
    },
    onProgress: ({ downloadedBytes, size }) => {
      console.error(
        `[python-plan] uv download progress: ${formatProgressBytes(downloadedBytes)}/${formatProgressBytes(size)}`
      );
    },
    onRetry: ({ attempt, delayMs, downloadedBytes, error, nextAttempt, size }) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[python-plan] uv download attempt ${String(attempt)} failed at ${formatProgressBytes(downloadedBytes)}/${formatProgressBytes(size)}: ${reason}; resuming with attempt ${String(nextAttempt)} in ${String(delayMs)}ms`
      );
    },
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    ...(configuredUv ? { uvBin: configuredUv } : {}),
  });
  const plannerWorkDir = await mkdtemp(path.join(os.tmpdir(), 'airgap-sync-plan-'));
  try {
    const resolver = new UvApplicationResolver();
    const results = [];
    for (const { index, target } of targets) {
      const application = resolveWorkspacePythonApplication(options.config, target);
      const sourceIndex = application.intent.source.indexUrl ?? 'https://pypi.org/simple/';
      const recipe = await readWorkspacePythonRecipe(options.workspaceDir, target);
      const indexClient = new MemoizedPythonIndexClient(new HttpPythonIndexClient(sourceIndex));
      const planned = [];
      for (const [selectorIndex, selector] of application.versionSelection.selectors.entries()) {
        const intent = pythonApplicationIntentForVersionSelector(application, selector);
        let result;
        try {
          result = await planPythonApplication({
            cacheDir: path.join(options.workspaceDir, '.airgap-sync', 'uv-cache'),
            coveragePolicy: application.coveragePolicy,
            createdAt,
            cutoff,
            index: indexClient,
            intent,
            ...(recipe ? { recipe } : {}),
            resolver,
            uvPath,
            workDir: path.join(plannerWorkDir, String(index), String(selectorIndex)),
          });
        } catch (error) {
          if (error instanceof PythonApplicationPlanningError) {
            const label = selector.type === 'exact' ? selector.version : 'latest-compatible';
            throw new PythonApplicationPlanningError(
              `Version selector ${label} failed: ${error.message}`,
              error.rejectedCandidates
            );
          }
          throw error;
        }
        const plan = addPythonRuntimeContract(result.plan, {
          ...(recipe ? { recipe } : {}),
        });
        planned.push({
          plan,
          result,
          selector,
          storageTargetId: pythonApplicationSelectorId(
            plan.application.name,
            plan.coverage.policy.id,
            selector
          ),
          targetId: pythonApplicationVariantId(
            plan.application.name,
            plan.application.version,
            plan.coverage.policy.id
          ),
        });
      }

      for (const item of planned) {
        const stored = await writeActivePythonApplicationPlan({
          evidence: item.result.evidence,
          generatedAt: createdAt,
          plan: item.plan,
          targetId: item.storageTargetId,
          targetIndex: index,
          workspaceDir: options.workspaceDir,
        });
        results.push({
          diff: stored.diff,
          index,
          plan: item.plan,
          rejectedCandidates: item.result.rejectedCandidates,
          selector: item.selector,
          storageTargetId: item.storageTargetId,
          targetId: item.targetId,
        });
      }
    }
    return results;
  } finally {
    await rm(plannerWorkDir, { force: true, recursive: true });
  }
}

interface GitFetchOptions {
  concurrency: number;
  dryRun?: boolean;
  mirrorsDir?: string;
}

interface GitApplyOptions {
  concurrency: number;
  dryRun?: boolean;
  gitea: string;
  password?: string;
  token?: string;
  mirrorsDir?: string;
  username?: string;
}

interface GitConfigOptions {
  dryRun?: boolean;
  gitea: string;
  global?: boolean;
}

interface SecretsCheckOptions {
  gitea?: string;
  token?: string;
}

const publishPhaseLabels: Record<PublishProgressPhase, string> = {
  auth: 'check npm auth',
  cleanup: 'cleanup temp tags',
  'dist-tags': 'restore dist-tags',
  'dry-run': 'plan publish',
  'lookup-metadata': 'lookup registry metadata',
  publish: 'publish packages',
  validate: 'validate publish tarballs',
};

type DownloadProgressEvent =
  | CollectProgressEvent
  | (PythonApplicationDownloadProgressEvent & {
      iteration?: undefined;
      phase: 'python-application-fetch';
      queue?: undefined;
    });

const collectPhaseLabels: Record<DownloadProgressEvent['phase'], string> = {
  'bundle-write': 'write bundle',
  'git-fetch': 'fetch git mirrors',
  'git-manifest-scan': 'scan git manifests',
  'lockfile-scan': 'scan lockfiles',
  'manifest-scan': 'scan package manifests',
  'npm-download': 'download npm tarballs',
  'npm-resolve': 'analyze npm dependency graph',
  'python-application-fetch': 'prepare Python application artifacts',
  'python-security-scan': 'scan Python package security',
  'repository-update': 'update repositories',
  'security-scan': 'scan npm package security',
};

const applyPhaseLabels: Record<ApplyProgressPhase, string> = {
  'cpython-distribution-publish': 'publish CPython distributions',
  gitea: 'provision Gitea repositories',
  'git-apply': 'push Git mirrors',
  'git-config': 'configure Git rewrites',
  publish: 'publish npm packages',
  'python-publish': 'publish Python wheels',
  'python-application-publish': 'publish Python application artifacts',
  report: 'write publish report',
};

const PROGRESS_HEARTBEAT_MS = 10_000;

function createApplyProgressLogger(): (event: ApplyProgressEvent) => void {
  const lastEvents = new Map<ApplyProgressPhase, ApplyProgressEvent>();
  const lastLogged = new Map<ApplyProgressPhase, number>();
  const lastOutputAt = new Map<ApplyProgressPhase, number>();
  const heartbeatTimers = new Map<ApplyProgressPhase, ReturnType<typeof setInterval>>();

  function needsHeartbeat(phase: ApplyProgressPhase): boolean {
    return (
      phase === 'gitea' ||
      phase === 'git-apply' ||
      phase === 'python-publish' ||
      phase === 'python-application-publish' ||
      phase === 'cpython-distribution-publish'
    );
  }

  function stopHeartbeat(phase: ApplyProgressPhase): void {
    const timer = heartbeatTimers.get(phase);
    if (timer) {
      clearInterval(timer);
      heartbeatTimers.delete(phase);
    }
  }

  function formatState(event: ApplyProgressEvent): string {
    const current = event.current === undefined ? '...' : String(event.current);
    const total = event.total === undefined ? '' : `/${String(event.total)}`;
    const bytes =
      event.bytes === undefined
        ? ''
        : ` bytes=${formatProgressBytes(event.bytes)}${
            event.totalBytes === undefined ? '' : `/${formatProgressBytes(event.totalBytes)}`
          }`;
    const detail = event.detail ? ` ${event.detail}` : '';
    return `${current}${total}${bytes}${detail}`;
  }

  return (event) => {
    const label = applyPhaseLabels[event.phase];
    lastEvents.set(event.phase, event);

    if (event.status === 'start') {
      const total = event.total === undefined ? '' : ` (${String(event.total)})`;
      console.error(`[publish] ${label}: started${total}`);
      lastOutputAt.set(event.phase, Date.now());
      stopHeartbeat(event.phase);
      if (needsHeartbeat(event.phase)) {
        const timer = setInterval(() => {
          const latest = lastEvents.get(event.phase);
          if (!latest) {
            return;
          }
          const previousOutputAt = lastOutputAt.get(event.phase) ?? 0;
          if (Date.now() - previousOutputAt < PROGRESS_HEARTBEAT_MS) {
            return;
          }
          console.error(`[publish] ${label}: still running ${formatState(latest)}`);
          lastOutputAt.set(event.phase, Date.now());
        }, PROGRESS_HEARTBEAT_MS);
        timer.unref();
        heartbeatTimers.set(event.phase, timer);
      }
      return;
    }

    if (event.status === 'done' || event.status === 'error') {
      stopHeartbeat(event.phase);
      const count =
        event.current === undefined
          ? ''
          : event.total === undefined
            ? ` (${String(event.current)})`
            : ` (${String(event.current)}/${String(event.total)})`;
      const detail = event.detail ? ` ${event.detail}` : '';
      console.error(`[publish] ${label}: ${event.status}${count}${detail}`);
      lastOutputAt.set(event.phase, Date.now());
      return;
    }

    if (event.current === undefined) {
      return;
    }
    const last = lastLogged.get(event.phase) ?? 0;
    const threshold =
      event.total && event.total > 0 ? Math.max(1, Math.ceil(event.total / 20)) : 25;
    const artifactCompleted = /^(?:error|missing-mirror|planned|published|pushed|skipped) /u.test(
      event.detail ?? ''
    );
    const shouldLog =
      !lastLogged.has(event.phase) ||
      (artifactCompleted && (event.current === 1 || event.current - last >= threshold)) ||
      (event.total !== undefined && event.current === event.total);
    if (!shouldLog) {
      return;
    }
    lastLogged.set(event.phase, event.current);
    console.error(`[publish] ${label}: ${formatState(event)}`);
    lastOutputAt.set(event.phase, Date.now());
  };
}

function formatProgressBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${String(bytes)} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1_024;
  let unit = units[0]!;
  for (const candidate of units.slice(1)) {
    if (value < 1_024) {
      break;
    }
    value /= 1_024;
    unit = candidate;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

function createCollectProgressLogger(): (event: DownloadProgressEvent) => void {
  const lastLogged = new Map<string, number>();
  const lastOutputAt = new Map<string, number>();
  const lastEvents = new Map<string, DownloadProgressEvent>();
  const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  function formatProgressState(event: DownloadProgressEvent): string {
    const total = event.total === undefined ? '' : `/${String(event.total)}`;
    const queue = event.queue === undefined ? '' : ` queue=${String(event.queue)}`;
    const bytes =
      'bytes' in event
        ? ` bytes=${formatProgressBytes(event.bytes)}${
            event.totalBytes === undefined ? '' : `/${formatProgressBytes(event.totalBytes)}`
          }`
        : '';
    const detail = event.detail ? ` ${event.detail}` : '';
    const current = event.current === undefined ? '...' : String(event.current);
    return `${current}${total}${queue}${bytes}${detail}`;
  }

  function formatProgressLine(event: DownloadProgressEvent, label: string, prefix: string): string {
    return `${prefix} ${label}: ${formatProgressState(event)}`;
  }

  function shouldHeartbeat(event: DownloadProgressEvent): boolean {
    // SSH reads passphrases from the controlling terminal. A heartbeat written while
    // it is waiting for input obscures that prompt even though the prompt remains active.
    return !(event.phase === 'git-fetch' && process.stdin.isTTY && process.stderr.isTTY);
  }

  function recordOutput(key: string): void {
    lastOutputAt.set(key, Date.now());
  }

  function stopHeartbeat(key: string): void {
    const timer = heartbeatTimers.get(key);
    if (timer) {
      clearInterval(timer);
      heartbeatTimers.delete(key);
    }
  }

  return (event) => {
    const label = collectPhaseLabels[event.phase];
    const prefix =
      event.iteration === undefined ? '[download]' : `[download:${String(event.iteration)}]`;
    const key = `${String(event.iteration ?? 0)}:${event.phase}`;
    lastEvents.set(key, event);

    if (event.status === 'start') {
      const detail = event.detail ? ` ${event.detail}` : '';
      const total = event.total === undefined ? '' : ` (${String(event.total)})`;
      console.error(`${prefix} ${label}: started${total}${detail}`);
      recordOutput(key);

      stopHeartbeat(key);
      if (!shouldHeartbeat(event)) {
        return;
      }
      const timer = setInterval(() => {
        const latest = lastEvents.get(key);
        if (!latest) {
          return;
        }
        const previousOutputAt = lastOutputAt.get(key) ?? 0;
        if (Date.now() - previousOutputAt < PROGRESS_HEARTBEAT_MS) {
          return;
        }
        console.error(`${prefix} ${label}: still running ${formatProgressState(latest)}`);
        recordOutput(key);
      }, PROGRESS_HEARTBEAT_MS);
      timer.unref();
      heartbeatTimers.set(key, timer);
      return;
    }

    if (event.status === 'done') {
      stopHeartbeat(key);
      const count =
        event.current === undefined
          ? ''
          : event.total === undefined
            ? ` (${String(event.current)})`
            : ` (${String(event.current)}/${String(event.total)})`;
      const detail = event.detail ? ` ${event.detail}` : '';
      console.error(`${prefix} ${label}: done${count}${detail}`);
      recordOutput(key);
      return;
    }

    if (event.status === 'error') {
      stopHeartbeat(key);
      const detail = event.detail ? ` ${event.detail}` : '';
      console.error(`${prefix} ${label}: error${detail}`);
      recordOutput(key);
      return;
    }

    if (event.status === 'warning') {
      const detail = event.detail ? ` ${event.detail}` : '';
      console.error(yellow(`${prefix} ${label}: WARNING${detail}`));
      recordOutput(key);
      return;
    }

    if (event.current === undefined) {
      return;
    }

    const last = lastLogged.get(key) ?? 0;
    const threshold =
      event.total && event.total > 0 ? Math.max(1, Math.ceil(event.total / 20)) : 25;
    const applicationArtifactCompleted =
      event.phase === 'python-application-fetch' &&
      /^(?:downloaded|existing|failed|reused|would-download) /u.test(event.detail ?? '');
    const applicationArtifactRetry =
      event.phase === 'python-application-fetch' && event.detail?.startsWith('retry ') === true;
    const npmTarballRetry =
      event.phase === 'npm-download' && event.detail?.startsWith('retry ') === true;
    const shouldLog =
      event.phase === 'python-application-fetch'
        ? !lastLogged.has(key) ||
          applicationArtifactRetry ||
          (applicationArtifactCompleted &&
            (event.current === 1 || event.current - last >= threshold)) ||
          event.current === event.total
        : npmTarballRetry ||
          event.phase === 'git-fetch' ||
          event.current === 1 ||
          event.current - last >= threshold ||
          (event.total !== undefined && event.current === event.total);

    if (!shouldLog) {
      return;
    }

    lastLogged.set(key, event.current);
    console.error(formatProgressLine(event, label, prefix));
    recordOutput(key);
  };
}

function formatGitFetchActionDetail(event: GitFetchProgressEvent): string | undefined {
  if (!event.action) {
    return event.repository;
  }

  const action = event.action;
  const parts = [action.repository, action.status];
  if (action.status === 'updated') {
    if (action.changed === false) {
      parts.push('unchanged');
    } else if (action.changed === true) {
      parts.push('changed');
    }
  }
  if (action.newCommits !== undefined) {
    parts.push(`+${String(action.newCommits)} commits`);
  }
  const refChanges =
    (action.addedRefs ?? 0) + (action.updatedRefs ?? 0) + (action.deletedRefs ?? 0);
  if (refChanges > 0) {
    parts.push(
      `refs +${String(action.addedRefs ?? 0)}/~${String(action.updatedRefs ?? 0)}/-${String(action.deletedRefs ?? 0)}`
    );
  }
  if (action.error) {
    parts.push(action.error);
  }

  return parts.join(' ');
}

function createGitFetchProgressLogger(): (event: GitFetchProgressEvent) => void {
  const logger = createCollectProgressLogger();
  return (event) => {
    const detail = formatGitFetchActionDetail(event);
    logger({
      current: event.current,
      ...(detail ? { detail } : {}),
      phase: 'git-fetch',
      status: event.status,
      total: event.total,
    });
  };
}

function createGitApplyProgressLogger(): (event: GitApplyProgressEvent) => void {
  const logger = createApplyProgressLogger();
  return (event) => {
    const detail = event.action
      ? `${event.action.status} ${event.action.repository}`
      : event.repository
        ? `pushing ${event.repository}`
        : undefined;
    logger({
      current: event.current,
      ...(detail ? { detail } : {}),
      phase: 'git-apply',
      status: event.status,
      total: event.total,
    });
  };
}

function createPublishProgressLogger(): (event: PublishProgressEvent) => void {
  const lastLogged = new Map<PublishProgressPhase, number>();

  return (event) => {
    const label = publishPhaseLabels[event.phase];

    if (event.status === 'start') {
      const total = event.total === undefined ? '' : ` (${String(event.total)})`;
      console.error(`[npm publish] ${label}: started${total}`);
      return;
    }

    if (event.status === 'done') {
      const total =
        event.total === undefined
          ? ''
          : ` (${String(event.current ?? event.total)}/${String(event.total)})`;
      console.error(`[npm publish] ${label}: done${total}`);
      return;
    }

    if (event.status === 'planned') {
      console.error(`[npm publish] ${label}: ${String(event.current ?? 0)} actions`);
      return;
    }

    if (event.current === undefined || event.total === undefined) {
      return;
    }

    const last = lastLogged.get(event.phase) ?? 0;
    const shouldLog =
      event.status === 'error' ||
      event.current === event.total ||
      event.current === 1 ||
      event.current - last >= Math.max(1, Math.ceil(event.total / 20));

    if (!shouldLog) {
      return;
    }

    lastLogged.set(event.phase, event.current);
    const subject = event.package ? ` ${event.package}${event.tag ? `#${event.tag}` : ''}` : '';
    console.error(
      `[npm publish] ${label}: ${String(event.current)}/${String(
        event.total
      )} ${event.status}${subject}`
    );
  };
}

interface GitCreateReposOptions {
  dryRun?: boolean;
  gitea: string;
  public?: boolean;
  token?: string;
}

interface ReposUpdateOptions {
  dryRun?: boolean;
}

const noopGiteaClient: GiteaClient = {
  createOrganization: () => Promise.resolve(),
  createRepository: () => Promise.resolve(),
  organizationExists: () => Promise.resolve(false),
  repositoryExists: () => Promise.resolve(false),
};

function toFetchPreview(result: ResolveRootRequirementsResult) {
  return {
    resolved: result.resolved.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      raw: pkg.raw,
      specifier: pkg.specifier,
      type: pkg.type,
      resolvedVia: pkg.resolvedVia,
      alias: pkg.alias,
      tarball: pkg.dist.tarball,
    })),
    errors: result.errors,
    tagRequirements: result.tagRequirements,
    warnings: result.warnings,
  };
}

function toFetchDryRun(result: FetchSeedBundleResult) {
  return {
    downloaded: result.downloaded,
    gitRequirements: result.gitRequirements,
    skipped: result.skipped,
    wouldDownload: result.wouldDownload,
    ...(result.vulnerabilityResolutions
      ? { vulnerabilityResolutions: result.vulnerabilityResolutions }
      : {}),
    ...toFetchPreview(result),
    unsupported: result.unsupported,
  };
}

function formatVerifyReport(report: VerifyReport): string {
  const lines = report.checks.map((item) => {
    const label = item.status === 'ok' ? 'OK' : item.status === 'warning' ? 'WARN' : 'ERROR';
    return `${label} ${item.name}: ${item.message}`;
  });
  lines.push(
    `SUMMARY ${String(report.summary.ok)} ok, ${String(report.summary.warnings)} warnings, ${String(report.summary.errors)} errors`
  );
  return lines.join('\n');
}

function formatVerifyInstallReport(report: VerifyInstallReport): string {
  const lines = report.projects.map((project) => {
    const label =
      project.status === 'passed' ? 'OK' : project.status === 'skipped' ? 'SKIP' : 'ERROR';
    const subject = project.packageManager
      ? `${project.projectPath} (${project.packageManager})`
      : project.projectPath;
    const detail =
      project.status === 'skipped'
        ? `: ${project.reason ?? 'skipped'}`
        : project.exitCode === undefined
          ? ''
          : `: exit ${String(project.exitCode)}`;
    return `${label} ${subject}${detail}`;
  });
  lines.push(
    `SUMMARY ${String(report.passed)} passed, ${String(report.skipped)} skipped, ${String(report.failed)} failed`
  );
  return lines.join('\n');
}

function formatReportStatus(name: string, report: BundleInfo['fetchReport']): string {
  if (!report.exists) {
    return `${name}: missing`;
  }

  const status = report.errors === 0 ? 'ok' : `${String(report.errors)} errors`;
  return `${name}: ${status}${report.generatedAt ? ` (${report.generatedAt})` : ''}`;
}

function formatBundleInfo(info: BundleInfo): string {
  const lines = [
    `Bundle: ${info.bundle}`,
    `Created: ${info.createdAt}`,
    `Source registry: ${info.sourceRegistry}`,
    `Packages: ${String(info.packageCount)} versions, ${String(info.packageNameCount)} names`,
    `Dist-tags: ${String(info.tagCount)}`,
    `CPython distributions: ${String(info.cpythonDistributions.artifactCount)} artifacts, ${String(info.cpythonDistributions.artifactBytes)} bytes; ${info.cpythonDistributions.pythonVersions.join(', ') || 'none'}; ${info.cpythonDistributions.platforms.join(', ') || 'no platforms'}`,
    `Python applications: ${String(info.pythonApplications.applications.length)}, ${String(info.pythonApplications.artifactCount)} shared artifacts, ${String(info.pythonApplications.artifactBytes)} bytes`,
    `Missing tarballs: ${String(info.missingTarballs.length)}`,
    `Validation: ${info.valid ? 'ok' : `${String(info.validationIssues.length)} issues`}`,
    formatReportStatus('Fetch report', info.fetchReport),
    formatReportStatus('Publish report', info.publishReport),
    formatReportStatus('CPython distribution fetch report', info.cpythonDistributions.fetchReport),
    formatReportStatus(
      'CPython distribution publish report',
      info.cpythonDistributions.publishReport
    ),
    formatReportStatus('Python application fetch report', info.pythonApplications.fetchReport),
    formatReportStatus('Python application publish report', info.pythonApplications.publishReport),
  ];

  if (info.missingTarballs.length > 0) {
    lines.push('', 'Missing tarballs:');
    lines.push(...info.missingTarballs.slice(0, 20).map((file) => `- ${file}`));
    if (info.missingTarballs.length > 20) {
      lines.push(`... ${String(info.missingTarballs.length - 20)} more`);
    }
  }

  return lines.join('\n');
}

async function ask(
  rl: ReadlineInterface,
  question: string,
  defaultValue?: string
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${question}${suffix}: `).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes('readline was closed')) {
      return defaultValue ?? '';
    }
    throw error;
  });
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : (defaultValue ?? '');
}

async function askYesNo(
  rl: ReadlineInterface,
  question: string,
  defaultValue: boolean
): Promise<boolean> {
  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
  const answer = await rl.question(`${question}${suffix}: `).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes('readline was closed')) {
      return '';
    }
    throw error;
  });
  const normalized = answer.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return normalized === 'y' || normalized === 'yes';
}

function promptBooleanToString(value: WorkspacePromptBoolean): string {
  return typeof value === 'boolean' ? (value ? 'yes' : 'no') : value;
}

function parsePromptBoolean(
  value: string,
  fallback: WorkspacePromptBoolean
): WorkspacePromptBoolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (normalized === 'ask' || normalized === 'a') {
    return 'ask';
  }

  if (normalized === 'yes' || normalized === 'y' || normalized === 'true') {
    return true;
  }

  if (normalized === 'no' || normalized === 'n' || normalized === 'false') {
    return false;
  }

  throw new Error(`Expected yes, no, or ask; got: ${value}`);
}

async function askPromptBoolean(
  rl: ReadlineInterface,
  question: string,
  current: WorkspacePromptBoolean
): Promise<WorkspacePromptBoolean> {
  return parsePromptBoolean(
    await ask(rl, `${question} (yes/no/ask)`, promptBooleanToString(current)),
    current
  );
}

async function askLatestPolicy(
  rl: ReadlineInterface,
  current: LatestPolicy
): Promise<LatestPolicy> {
  const answer = await ask(rl, 'Latest policy (bundled/source)', current);
  return parseLatestPolicy(answer || current);
}

async function askTagResolutionPolicy(
  rl: ReadlineInterface,
  current: TagResolutionPolicy
): Promise<TagResolutionPolicy> {
  const answer = await ask(rl, 'Tag resolution policy (reuse-stable/refresh)', current);
  return parseTagResolutionPolicy(answer || current);
}

async function askRangeResolutionPolicy(
  rl: ReadlineInterface,
  current: RangeResolutionPolicy
): Promise<RangeResolutionPolicy> {
  const answer = await ask(rl, 'Range resolution policy (reuse-stable/refresh)', current);
  return parseRangeResolutionPolicy(answer || current);
}

async function resolvePromptBoolean(
  rl: ReadlineInterface,
  question: string,
  value: WorkspacePromptBoolean,
  promptDefault: boolean
): Promise<boolean> {
  return value === 'ask' ? await askYesNo(rl, question, promptDefault) : value;
}

async function readSavedGiteaToken(workspaceDir: string): Promise<string | undefined> {
  return (await readWorkspaceSecrets(workspaceDir)).giteaToken;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function resolveGiteaToken(options: {
  cliToken: string | undefined;
  workspaceDir: string;
}): Promise<string | undefined> {
  return (
    options.cliToken ?? process.env.GITEA_TOKEN ?? (await readSavedGiteaToken(options.workspaceDir))
  );
}

async function requireGiteaToken(options: {
  cliToken: string | undefined;
  optionName: string;
  workspaceDir: string;
}): Promise<string> {
  const token = await resolveGiteaToken(options);
  if (!token) {
    throw new Error(
      `provide ${options.optionName}, set GITEA_TOKEN, or save a token in ${workspaceSecretsFileName}`
    );
  }

  return token;
}

function explicitGitAuth(options: {
  password: string | undefined;
  username: string | undefined;
}): { password: string; username: string } | undefined {
  if (!options.password && !options.username) {
    return undefined;
  }

  if (!options.password || !options.username) {
    throw new Error('provide both Git username and Git password/token');
  }

  return {
    password: options.password,
    username: options.username,
  };
}

async function resolvePublishWorkspaceDefaults(options: {
  bundle: string | undefined;
  gitea: string | undefined;
  registry: string | undefined;
  npmOwner?: string;
  npmRegistryType?: string;
  pythonOwner?: string;
  gitOwnerStrategy?: GitOwnerStrategy;
  gitPublishOwner?: string;
  gitPublishOwnerKind?: GitPublishOwnerKind;
}): Promise<{
  bundle: string;
  configureGitGlobal?: WorkspacePromptBoolean;
  gitea: string;
  provisionGit?: WorkspacePromptBoolean;
  publicRepositories?: WorkspacePromptBoolean;
  pythonOwner?: string;
  pythonPublicationProfile: PythonPublicationProfile;
  gitOwnerStrategy: GitOwnerStrategy;
  gitPublishOwner?: string;
  gitPublishOwnerKind?: GitPublishOwnerKind;
  npmRegistryTarget: NpmRegistryTarget;
  workspaceDir: string;
}> {
  if (
    options.gitOwnerStrategy !== undefined &&
    !['preserve', 'authenticated-user', 'fixed-owner'].includes(options.gitOwnerStrategy)
  ) {
    throw new Error('--git-owner-strategy must be preserve, authenticated-user, or fixed-owner');
  }
  if (
    options.gitPublishOwnerKind !== undefined &&
    !['user', 'organization'].includes(options.gitPublishOwnerKind)
  ) {
    throw new Error('--git-publish-owner-kind must be user or organization');
  }
  if (
    options.npmRegistryType !== undefined &&
    options.npmRegistryType !== 'verdaccio' &&
    options.npmRegistryType !== 'gitea'
  ) {
    throw new Error('--npm-registry-type must be verdaccio or gitea');
  }
  if (options.registry && options.npmRegistryType === 'gitea') {
    throw new Error('--registry cannot be used with --npm-registry-type gitea');
  }
  const workspaceDir = process.cwd();
  const needsConfig =
    !options.bundle ||
    !options.gitea ||
    (!options.registry && options.npmRegistryType === undefined && !options.npmOwner);
  let config: WorkspaceConfig | undefined;
  if (needsConfig || options.pythonOwner === undefined || options.gitOwnerStrategy === undefined) {
    try {
      config = await readWorkspaceConfig(workspaceDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (needsConfig) {
          throw new Error(
            `provide <bundle>, an npm registry target, and --gitea, or run from a workspace with ${workspaceConfigFileName}`
          );
        }
        config = undefined;
      } else {
        throw error;
      }
    }
  }
  const bundle = options.bundle ?? config?.output;
  const gitea = options.gitea ?? config?.giteaUrl;
  const configuredNpmRegistry = config?.npmRegistry;
  let npmRegistryTarget: NpmRegistryTarget | undefined;
  if (options.registry) {
    npmRegistryTarget = { type: 'verdaccio', url: options.registry };
  } else if (options.npmRegistryType === 'gitea' || options.npmOwner) {
    const configuredGitea =
      configuredNpmRegistry?.type === 'gitea' ? configuredNpmRegistry : undefined;
    npmRegistryTarget = {
      owner: options.npmOwner
        ? { kind: 'organization', name: options.npmOwner, strategy: 'fixed-owner' }
        : (configuredGitea?.owner ?? {
            kind: 'organization',
            name: defaultGiteaNpmOwner,
            strategy: 'fixed-owner',
          }),
      type: 'gitea',
      visibility: configuredGitea?.visibility ?? 'public',
    };
  } else if (options.npmRegistryType === 'verdaccio') {
    npmRegistryTarget =
      configuredNpmRegistry?.type === 'verdaccio' ? configuredNpmRegistry : undefined;
  } else {
    npmRegistryTarget = configuredNpmRegistry;
  }

  if (!bundle) {
    throw new Error('provide <bundle> or configure output in airgap-sync.json');
  }
  if (!npmRegistryTarget) {
    throw new Error(
      'provide --registry <url>, select --npm-registry-type gitea, or configure npmRegistry in airgap-sync.json'
    );
  }
  if (!gitea) {
    throw new Error('provide --gitea <url> or configure giteaUrl in airgap-sync.json');
  }
  const pythonOwner =
    options.pythonOwner ?? (config?.schemaVersion === 1 ? config.pythonPublishOwner : undefined);
  const pythonPublicationProfile = config?.python?.publication ?? defaultPythonPublicationProfile();
  const gitOwnerStrategy = options.gitOwnerStrategy ?? config?.gitOwnerStrategy ?? 'preserve';
  const gitPublishOwner = options.gitPublishOwner ?? config?.gitPublishOwner;
  const gitPublishOwnerKind = options.gitPublishOwnerKind ?? config?.gitPublishOwnerKind;
  if (gitOwnerStrategy === 'fixed-owner' && (!gitPublishOwner || !gitPublishOwnerKind)) {
    throw new Error(
      'fixed-owner strategy requires --git-publish-owner and --git-publish-owner-kind'
    );
  }

  return {
    bundle,
    ...(config ? { configureGitGlobal: config.defaults.publish.configureGitGlobal } : {}),
    gitea,
    gitOwnerStrategy,
    ...(gitPublishOwner ? { gitPublishOwner } : {}),
    ...(gitPublishOwnerKind ? { gitPublishOwnerKind } : {}),
    ...(config ? { provisionGit: config.defaults.publish.provisionGit } : {}),
    ...(config ? { publicRepositories: config.defaults.publish.publicRepositories } : {}),
    ...(pythonOwner ? { pythonOwner } : {}),
    pythonPublicationProfile,
    npmRegistryTarget,
    workspaceDir,
  };
}

async function giteaTokenFromMenu(workspaceDir: string, rl: ReadlineInterface): Promise<string> {
  const envToken = process.env.GITEA_TOKEN;
  if (envToken) {
    return envToken;
  }

  const savedToken = await readSavedGiteaToken(workspaceDir);
  if (savedToken) {
    console.error(
      `[menu] publish updates: using saved Gitea token from ${workspaceSecretsFileName}`
    );
    return savedToken;
  }

  const token = await ask(rl, 'Gitea token (visible input)');
  if (!token) {
    throw new Error('Gitea token is required for publish');
  }

  if (await askYesNo(rl, `Save Gitea token in ${workspaceSecretsFileName}?`, false)) {
    await saveWorkspaceGiteaToken(workspaceDir, token);
    console.log(`Saved Gitea token in ${workspaceSecretsFileName}.`);
  }

  return token;
}

async function checkGiteaToken(giteaUrl: string, token: string): Promise<string> {
  return await new HttpGiteaClient(giteaUrl, { authToken: token }).currentUserLogin();
}

async function saveWorkspaceConfig(workspaceDir: string, config: WorkspaceConfig): Promise<void> {
  await writeWorkspaceConfig(workspaceDir, config);
  await mkdir(path.resolve(workspaceDir, config.output), { recursive: true });
}

async function configureConnectionSettings(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  const sourceRegistry = await ask(rl, 'Source npm registry', config.sourceRegistry);
  const giteaUrl = await ask(
    rl,
    'Closed-network Gitea URL',
    config.giteaUrl ?? defaultWorkspaceGiteaUrl
  );
  const currentNpmRegistry = config.npmRegistry ?? defaultNpmRegistryTarget();
  const npmRegistryType = (
    await ask(rl, 'Closed-network npm registry type (verdaccio/gitea)', currentNpmRegistry.type)
  )
    .trim()
    .toLowerCase();
  if (npmRegistryType !== 'verdaccio' && npmRegistryType !== 'gitea') {
    throw new Error('npm registry type must be verdaccio or gitea');
  }
  let npmRegistry: NpmRegistryTarget;
  if (npmRegistryType === 'verdaccio') {
    const fallback =
      currentNpmRegistry.type === 'verdaccio'
        ? currentNpmRegistry.url
        : defaultVerdaccioRegistryUrl;
    const url = (await ask(rl, 'Closed-network Verdaccio URL', fallback)).trim();
    if (!url) {
      throw new Error('Verdaccio URL is required');
    }
    npmRegistry = { type: 'verdaccio', url };
  } else {
    const pythonOwner = config.python?.publication?.owner;
    const currentOwner =
      currentNpmRegistry.type === 'gitea' && currentNpmRegistry.owner.strategy === 'fixed-owner'
        ? currentNpmRegistry.owner.name
        : pythonOwner?.strategy === 'fixed-owner'
          ? pythonOwner.name
          : defaultGiteaNpmOwner;
    const owner = (
      await ask(rl, 'Managed Gitea organization for npm packages', currentOwner)
    ).trim();
    if (!owner) {
      throw new Error('Gitea npm organization is required');
    }
    const isPublic = await askYesNo(
      rl,
      'Make the managed npm package owner public?',
      currentNpmRegistry.type !== 'gitea' || currentNpmRegistry.visibility === 'public'
    );
    npmRegistry = {
      owner: { kind: 'organization', name: owner, strategy: 'fixed-owner' },
      type: 'gitea',
      visibility: isPublic ? 'public' : 'private',
    };
  }
  const nextConfig: WorkspaceConfig = {
    ...config,
    npmRegistry,
    sourceRegistry,
    ...(giteaUrl ? { giteaUrl } : {}),
  };
  await saveWorkspaceConfig(workspaceDir, nextConfig);
  return nextConfig;
}

async function configureInitialGiteaToken(
  workspaceDir: string,
  rl: ReadlineInterface
): Promise<void> {
  if (process.env.GITEA_TOKEN) {
    console.log('Using Gitea token from GITEA_TOKEN; no token will be saved.');
    return;
  }

  if (await readSavedGiteaToken(workspaceDir)) {
    console.log(`Using the Gitea token already saved in ${workspaceSecretsFileName}.`);
    return;
  }

  const token = await ask(
    rl,
    'Gitea token to save (visible input; leave empty to configure later)'
  );
  if (!token) {
    console.log('Skipped Gitea token setup.');
    return;
  }

  await saveWorkspaceGiteaToken(workspaceDir, token);
  console.log(`Saved Gitea token in ${workspaceSecretsFileName}.`);
}

async function configureBundleDirectory(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  const output = await ask(rl, 'Bundle directory', config.output || defaultWorkspaceOutputDir);
  const nextConfig = {
    ...config,
    output: output || defaultWorkspaceOutputDir,
  };
  await saveWorkspaceConfig(workspaceDir, nextConfig);
  return nextConfig;
}

function parseApplicationCoverageChoice(value: string): PlatformCoveragePolicy['platforms'] {
  switch (value.trim().toLowerCase()) {
    case 'both':
      return ['windows-x86_64', 'linux-glibc-x86_64'];
    case 'windows':
      return ['windows-x86_64'];
    case 'linux':
      return ['linux-glibc-x86_64'];
    default:
      throw new Error('Python application platforms must be both, windows, or linux');
  }
}

async function configureApplicationCoverage(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  if (config.schemaVersion !== 2) {
    throw new Error('Python application coverage requires workspace schemaVersion 2');
  }
  const configuredCoverage = config.python?.applicationDefaults?.coverage;
  const current =
    typeof configuredCoverage === 'string'
      ? config.coveragePolicies?.find((policy) => policy.id === configuredCoverage)
      : undefined;
  const currentPlatforms =
    typeof configuredCoverage === 'object'
      ? configuredCoverage.platforms
      : (current?.platforms ?? config.coveragePolicies?.[0]?.platforms);
  const currentChoice =
    currentPlatforms?.length === 1
      ? currentPlatforms[0] === 'windows-x86_64'
        ? 'windows'
        : 'linux'
      : 'both';
  const platforms = parseApplicationCoverageChoice(
    await ask(rl, 'Python application platforms (both/windows/linux)', currentChoice)
  );
  const policy: PlatformCoveragePolicy = {
    id: current?.id ?? config.coveragePolicies?.[0]?.id ?? 'desktop-x64',
    platforms,
    version: 1,
    wheelStrategy: 'minimum-cover',
  };
  const policies = config.coveragePolicies ?? [];
  const policyExists = policies.some((candidate) => candidate.id === policy.id);
  const nextConfig: WorkspaceConfig = {
    ...config,
    coveragePolicies: policyExists
      ? policies.map((candidate) => (candidate.id === policy.id ? policy : candidate))
      : [policy, ...policies],
    python: {
      ...config.python,
      applicationDefaults: {
        coverage: policy.id,
        runtime: config.python?.applicationDefaults?.runtime ?? {
          policy: 'selected',
          versions: [...initialPythonApplicationMinors],
        },
      },
      planner: config.python?.planner ?? {
        engine: 'uv',
        version: workspacePythonPlannerVersion,
      },
      sourceIndex: config.python?.sourceIndex ?? defaultPythonSourceIndex,
    },
  };
  await saveWorkspaceConfig(workspaceDir, nextConfig);
  return nextConfig;
}

async function configureApplicationPythonRuntime(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  if (config.schemaVersion !== 2) {
    throw new Error('Python application defaults require workspace schemaVersion 2');
  }
  const current = config.python?.applicationDefaults?.runtime ?? {
    policy: 'selected' as const,
    versions: [...initialPythonApplicationMinors],
  };
  const answer = await ask(
    rl,
    'Default Python minor versions (comma-separated)',
    current.policy === 'selected'
      ? current.versions.join(', ')
      : initialPythonApplicationMinors.join(', ')
  );
  const versions = splitMenuValues(answer);
  if (versions.length === 0) {
    throw new Error('At least one default Python minor version is required');
  }
  const nextConfig: WorkspaceConfig = {
    ...config,
    python: {
      ...config.python,
      applicationDefaults: {
        coverage: config.python?.applicationDefaults?.coverage ??
          config.coveragePolicies?.[0]?.id ?? {
            platforms: ['linux-glibc-x86_64'],
            version: 1,
            wheelStrategy: 'minimum-cover',
          },
        runtime: {
          policy: 'selected',
          versions,
        },
      },
      planner: config.python?.planner ?? {
        engine: 'uv',
        version: workspacePythonPlannerVersion,
      },
      sourceIndex: config.python?.sourceIndex ?? defaultPythonSourceIndex,
    },
  };
  await saveWorkspaceConfig(workspaceDir, nextConfig);
  return nextConfig;
}

async function configurePythonApplicationPublication(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  if (config.schemaVersion !== 2) {
    throw new Error('Python application settings require workspace schemaVersion 2');
  }
  const sourceIndex = validatePythonIndexUrl(
    await ask(
      rl,
      'Public Python source index',
      config.python?.sourceIndex ?? defaultPythonSourceIndex
    )
  );
  const currentPublication = config.python?.publication ?? defaultPythonPublicationProfile();
  const currentOwner =
    currentPublication.owner.strategy === 'fixed-owner'
      ? currentPublication.owner.name
      : 'airgap-packages';
  const owner = (
    await ask(rl, 'Managed Gitea organization for Python packages', currentOwner)
  ).trim();
  if (!owner) {
    throw new Error('Python publication organization is required');
  }
  const publishEvidence = currentPublication.publishEvidence === true;
  const splitOwners = publishEvidence
    ? await askYesNo(
        rl,
        'Use separate organizations for PyPI and optional Generic evidence?',
        Boolean(currentPublication.pypiOwner ?? currentPublication.genericOwner)
      )
    : false;
  const pypiOwner = splitOwners
    ? (
        await ask(
          rl,
          'Gitea organization for PyPI wheels',
          currentPublication.pypiOwner?.strategy === 'fixed-owner'
            ? currentPublication.pypiOwner.name
            : owner
        )
      ).trim()
    : undefined;
  const genericOwner = splitOwners
    ? (
        await ask(
          rl,
          'Gitea organization for Generic Packages',
          currentPublication.genericOwner?.strategy === 'fixed-owner'
            ? currentPublication.genericOwner.name
            : owner
        )
      ).trim()
    : undefined;
  if (splitOwners && (!pypiOwner || !genericOwner)) {
    throw new Error('Both Python publication organizations are required');
  }
  const nextConfig: WorkspaceConfig = {
    ...config,
    python: {
      ...config.python,
      planner: config.python?.planner ?? {
        engine: 'uv',
        version: workspacePythonPlannerVersion,
      },
      publication: {
        ...(genericOwner
          ? {
              genericOwner: {
                kind: 'organization' as const,
                name: genericOwner,
                strategy: 'fixed-owner' as const,
              },
            }
          : {}),
        owner: {
          kind: 'organization',
          name: owner,
          strategy: 'fixed-owner',
        },
        ...(pypiOwner
          ? {
              pypiOwner: {
                kind: 'organization' as const,
                name: pypiOwner,
                strategy: 'fixed-owner' as const,
              },
            }
          : {}),
        ...(publishEvidence ? { publishEvidence: true } : {}),
        visibility: 'public',
      },
      sourceIndex,
    },
  };
  await saveWorkspaceConfig(workspaceDir, nextConfig);
  return nextConfig;
}

async function configureDownloadDefaults(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  const includeDev = await askPromptBoolean(
    rl,
    'Include devDependencies by default',
    config.defaults.download.includeDev
  );
  const includePeer = await askPromptBoolean(
    rl,
    'Traverse peerDependencies by default',
    config.defaults.download.includePeer
  );
  const latestPolicy = await askLatestPolicy(rl, config.defaults.download.latestPolicy);
  const rangeResolutionPolicy = await askRangeResolutionPolicy(
    rl,
    config.defaults.download.rangeResolutionPolicy
  );
  const tagResolutionPolicy = await askTagResolutionPolicy(
    rl,
    config.defaults.download.tagResolutionPolicy
  );
  const prune = await askPromptBoolean(
    rl,
    'Prune stale bundle objects after successful download',
    config.defaults.download.prune
  );
  const nextConfig: WorkspaceConfig = {
    ...config,
    defaults: {
      ...config.defaults,
      download: {
        includeDev,
        includePeer,
        latestPolicy,
        prune,
        rangeResolutionPolicy,
        tagResolutionPolicy,
      },
    },
  };
  await saveWorkspaceConfig(workspaceDir, nextConfig);
  return nextConfig;
}

async function configurePublishDefaults(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  const provisionGit = await askPromptBoolean(
    rl,
    'Create/check missing Git repositories through Gitea API by default',
    config.defaults.publish.provisionGit
  );
  const publicRepositories = await askPromptBoolean(
    rl,
    'Create public Gitea repositories by default',
    config.defaults.publish.publicRepositories
  );
  const configureGitGlobal = await askPromptBoolean(
    rl,
    'Configure global Git rewrites by default',
    config.defaults.publish.configureGitGlobal
  );
  const nextConfig: WorkspaceConfig = {
    ...config,
    defaults: {
      ...config.defaults,
      publish: {
        configureGitGlobal,
        provisionGit,
        publicRepositories,
      },
    },
  };
  await saveWorkspaceConfig(workspaceDir, nextConfig);
  return nextConfig;
}

async function configureVerifyInstallDefaults(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  const ignoreScripts = await askPromptBoolean(
    rl,
    'Ignore lifecycle scripts during install verification by default',
    config.defaults.verifyInstall.ignoreScripts
  );
  const nextConfig: WorkspaceConfig = {
    ...config,
    defaults: {
      ...config.defaults,
      verifyInstall: {
        ignoreScripts,
      },
    },
  };
  await saveWorkspaceConfig(workspaceDir, nextConfig);
  return nextConfig;
}

async function configureInitialWorkspace(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  console.log('Configure workspace defaults.');
  const withBundle = await configureBundleDirectory(workspaceDir, rl, config);
  const withConnections = await configureConnectionSettings(workspaceDir, rl, withBundle);
  await configureInitialGiteaToken(workspaceDir, rl);
  console.log('Configure Python application coverage.');
  const withPythonSettings =
    withConnections.schemaVersion === 2
      ? await configureApplicationCoverage(workspaceDir, rl, withConnections)
      : withConnections;
  const withPythonDefaults =
    withPythonSettings.schemaVersion === 2
      ? await configureApplicationPythonRuntime(workspaceDir, rl, withPythonSettings)
      : withPythonSettings;
  console.log('Configure download defaults.');
  const withDownloadDefaults = await configureDownloadDefaults(
    workspaceDir,
    rl,
    withPythonDefaults
  );
  console.log('Configure publish defaults.');
  const withPublishDefaults = await configurePublishDefaults(
    workspaceDir,
    rl,
    withDownloadDefaults
  );
  console.log('Configure install verification defaults.');
  return await configureVerifyInstallDefaults(workspaceDir, rl, withPublishDefaults);
}

async function readMenuWorkspace(workspaceDir: string, rl: ReadlineInterface) {
  try {
    const migration = await migrateWorkspaceConfig(workspaceDir);
    if (migration.appliedMigrationIds.length > 0) {
      console.log(
        `[migration] applied ${migration.appliedMigrationIds.join(', ')}; backup: ${migration.backupPath ?? '(not created)'}`
      );
    }
    return migration.config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    if (
      !(await askYesNo(rl, `${workspaceConfigFileName} not found. Initialize workspace?`, true))
    ) {
      throw error;
    }
    return await configureInitialWorkspace(workspaceDir, rl, await initWorkspace({ workspaceDir }));
  }
}

function printMenu(): void {
  console.log('\nairgap-sync');
  console.log('1. Targets');
  console.log('2. Download updates');
  console.log('3. Publish updates');
  console.log('4. Verify installs');
  console.log('5. Diagnostics');
  console.log('6. Settings');
  console.log('0. Exit');
}

function splitMenuValues(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function addCpythonDistributionsFromMenu(
  workspaceDir: string,
  rl: ReadlineInterface
): Promise<void> {
  const supportedPlatforms = listBuiltInPlatformFamilies()
    .filter((platform) => platform.status === 'supported')
    .map((platform) => platform.id);
  const fromMinor = await ask(rl, 'Lowest CPython minor', '3.10');
  const platforms = splitMenuValues(
    await ask(rl, 'Platforms (comma-separated)', supportedPlatforms.join(', '))
  );
  const latest = parsePositiveInteger(
    await ask(rl, 'Latest patch versions per minor and platform', '1')
  );
  const windowDays = parsePositiveInteger(await ask(rl, 'Provider build window in days', '365'));
  await runSelfCommand(
    [
      'target',
      'add',
      'cpython-distributions',
      workspaceDir,
      '--from-minor',
      fromMinor,
      ...platforms.flatMap((platform) => ['--platform', platform]),
      '--latest',
      String(latest),
      '--window-days',
      String(windowDays),
    ],
    workspaceDir
  );
}

async function editTargetFromMenu(workspaceDir: string, rl: ReadlineInterface): Promise<void> {
  const config = await readMenuWorkspace(workspaceDir, rl);
  console.log(formatTargetList(config.targets));
  if (config.targets.length === 0) {
    return;
  }
  const indexValue = await ask(rl, 'Target index to edit');
  if (!indexValue) {
    return;
  }
  const index = parsePositiveInteger(indexValue);
  const target = config.targets[index - 1];
  if (!target) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }
  const editableFields = workspaceTargetEditableFields(target);
  if (editableFields.length === 0) {
    console.log(
      `Target ${String(index)} (${target.type}) has no editable settings. Remove and add a new target to change its identity.`
    );
    return;
  }
  console.log(`Editing: ${formatTargetValue(target)}`);

  switch (target.type) {
    case 'cpython-distributions': {
      const fromMinor = await ask(rl, 'Lowest CPython minor', target.series.from);
      const platforms = splitMenuValues(
        await ask(rl, 'Platforms (comma-separated)', target.platforms.join(', '))
      );
      const latest = parsePositiveInteger(
        await ask(rl, 'Latest patch versions per minor and platform', String(target.patches.latest))
      );
      const windowDays = parsePositiveInteger(
        await ask(rl, 'Provider build window in days', String(target.builds.windowDays))
      );
      await runSelfCommand(
        [
          'target',
          'edit',
          indexValue,
          workspaceDir,
          '--from-minor',
          fromMinor,
          ...platforms.flatMap((platform) => ['--platform', platform]),
          '--latest',
          String(latest),
          '--window-days',
          String(windowDays),
        ],
        workspaceDir
      );
      return;
    }
    case 'git': {
      const branch = await ask(
        rl,
        'Branch (enter current/new value, or "-" to clear)',
        target.branch ?? ''
      );
      await runSelfCommand(
        [
          'target',
          'edit',
          indexValue,
          workspaceDir,
          ...(branch === '-' ? ['--clear-branch'] : branch ? ['--branch', branch] : []),
        ],
        workspaceDir
      );
      return;
    }
    case 'python-app': {
      console.log(
        `Coverage override: ${
          typeof target.coverage === 'string'
            ? target.coverage
            : target.coverage
              ? target.coverage.platforms.join(', ')
              : '(workspace default)'
        }`
      );
      console.log(`Python override: ${formatPythonRuntimePolicy(target.python)}`);
      const versions = splitMenuValues(
        await ask(rl, 'New application versions (comma-separated exact versions or latest)')
      );
      const coverage = await ask(rl, 'Coverage override (empty keeps current, "-" inherits)');
      const python = await ask(
        rl,
        'Python override (comma-separated minors, empty keeps current, "-" inherits)'
      );
      const pythonVersions = splitMenuValues(python);
      const pythonArgs =
        python === '-'
          ? ['--inherit-python']
          : pythonVersions.length > 0 &&
              pythonVersions.every((version) => /^3\.\d+$/u.test(version))
            ? pythonVersions.flatMap((version) => ['--python-version', version])
            : python
              ? ['--python', python]
              : [];
      const coverageArgs =
        coverage === '-' ? ['--inherit-coverage'] : coverage ? ['--coverage', coverage] : [];
      if (versions.length === 0 && coverageArgs.length === 0 && pythonArgs.length === 0) {
        console.log('No target changes requested.');
        return;
      }
      await runSelfCommand(
        [
          'target',
          'edit',
          indexValue,
          workspaceDir,
          ...versions.flatMap((version) => ['--include-version', version]),
          ...coverageArgs,
          ...pythonArgs,
        ],
        workspaceDir
      );
      return;
    }
    case 'npm':
      console.log(`Target ${String(index)} (npm) has no editable settings.`);
  }
}

async function configureTargetsMenu(workspaceDir: string, rl: ReadlineInterface): Promise<void> {
  for (;;) {
    console.log('\nTargets');
    console.log('1. Show targets');
    console.log('2. Add Git target');
    console.log('3. Add npm target');
    console.log('4. Add Python application');
    console.log('5. Add CPython distributions');
    console.log('6. Edit target');
    console.log('7. Remove target');
    console.log('8. Download selected target');
    console.log('0. Back');

    const choice = await ask(rl, 'Choose an action', '0');
    switch (choice) {
      case '0':
        return;
      case '1':
        await runSelfCommand(['target', 'list', workspaceDir], workspaceDir);
        break;
      case '2': {
        const url = await ask(rl, 'Git repository URL');
        const branch = await ask(rl, 'Branch (optional)');
        if (url) {
          await runSelfCommand(
            compactArgs([
              'target',
              'add',
              'git',
              url,
              workspaceDir,
              branch ? '--branch' : undefined,
              branch,
            ]),
            workspaceDir
          );
        }
        break;
      }
      case '3': {
        const spec = await ask(rl, 'npm package spec');
        if (spec) {
          await runSelfCommand(['target', 'add', 'npm', spec, workspaceDir], workspaceDir);
        }
        break;
      }
      case '4': {
        let config = await readMenuWorkspace(workspaceDir, rl);
        if (!config.python?.applicationDefaults?.coverage) {
          console.log('Configure platform coverage for Python applications.');
          config = await configureApplicationCoverage(workspaceDir, rl, config);
        }
        const coveragePolicyIds = config.coveragePolicies?.map((policy) => policy.id) ?? [];
        const defaultCoverage = config.python?.applicationDefaults?.coverage;
        if (!defaultCoverage) {
          throw new Error('Python application coverage was not configured');
        }
        const spec = await ask(rl, 'Python application package');
        const applicationVersions = (
          await ask(rl, 'Application versions (comma-separated exact versions or latest)', 'latest')
        )
          .split(',')
          .map((version) => version.trim())
          .filter(Boolean);
        const coverage = await ask(
          rl,
          `Coverage override (${coveragePolicyIds.join('/')}; empty uses workspace default)`,
          ''
        );
        const pythonVersions = splitMenuValues(
          await ask(rl, 'Python versions override (comma-separated; empty uses workspace default)')
        );
        if (spec) {
          await runSelfCommand(
            [
              'target',
              'add',
              'python-app',
              spec,
              workspaceDir,
              ...(coverage ? ['--coverage', coverage] : []),
              ...applicationVersions.flatMap((version) => ['--include-version', version]),
              ...pythonVersions.flatMap((version) => ['--python-version', version]),
            ],
            workspaceDir
          );
        }
        break;
      }
      case '5':
        await addCpythonDistributionsFromMenu(workspaceDir, rl);
        break;
      case '6':
        await editTargetFromMenu(workspaceDir, rl);
        break;
      case '7': {
        await runSelfCommand(['target', 'list', workspaceDir], workspaceDir);
        const index = await ask(rl, 'Target index to remove');
        if (index) {
          await runSelfCommand(['target', 'remove', index, workspaceDir], workspaceDir);
        }
        break;
      }
      case '8': {
        await runSelfCommand(['target', 'list', workspaceDir], workspaceDir);
        const index = await ask(rl, 'Target index to download');
        if (index) {
          await runSelfCommand(['download', '--target', index], workspaceDir);
        }
        break;
      }
      default:
        console.log('Unknown menu item.');
    }
  }
}

async function configurePythonSettingsMenu(
  workspaceDir: string,
  rl: ReadlineInterface
): Promise<void> {
  for (;;) {
    const config = await readMenuWorkspace(workspaceDir, rl);
    const defaultCoverageSelection =
      config.python?.applicationDefaults?.coverage ?? config.coveragePolicies?.[0]?.id;
    const defaultCoverage =
      typeof defaultCoverageSelection === 'string'
        ? config.coveragePolicies?.find((policy) => policy.id === defaultCoverageSelection)
        : defaultCoverageSelection;
    const defaultCoverageId =
      typeof defaultCoverageSelection === 'string' ? defaultCoverageSelection : undefined;
    const publication = config.python?.publication ?? defaultPythonPublicationProfile();
    const publicationOwner =
      publication.owner.strategy === 'authenticated-user'
        ? 'authenticated user'
        : `${publication.owner.kind} ${publication.owner.name}`;
    console.log('\nPython applications');
    console.log(`Source index: ${config.python?.sourceIndex ?? defaultPythonSourceIndex}`);
    console.log(`Publication owner: ${publicationOwner}`);
    console.log(
      `PyPI override: ${
        publication.pypiOwner?.strategy === 'fixed-owner'
          ? publication.pypiOwner.name
          : publication.pypiOwner
            ? 'authenticated user'
            : '(shared)'
      }`
    );
    console.log(
      `Generic override: ${
        publication.genericOwner?.strategy === 'fixed-owner'
          ? publication.genericOwner.name
          : publication.genericOwner
            ? 'authenticated user'
            : '(shared)'
      }`
    );
    console.log(
      `Default coverage: ${
        defaultCoverage
          ? `${defaultCoverageId ? `${defaultCoverageId} ` : ''}(${defaultCoverage.platforms.join(', ')})`
          : '(not set)'
      }`
    );
    console.log(
      `Default Python runtime: ${formatPythonRuntimePolicy(config.python?.applicationDefaults?.runtime)}`
    );
    console.log('Actions:');
    console.log('1. Configure source and publication');
    console.log('2. Configure default platform coverage');
    console.log('3. Configure default Python versions');
    console.log('0. Back');

    const choice = await ask(rl, 'Choose an action', '0');
    switch (choice) {
      case '0':
        return;
      case '1':
        await configurePythonApplicationPublication(workspaceDir, rl, config);
        console.log('Saved Python application publication settings.');
        break;
      case '2':
        await configureApplicationCoverage(workspaceDir, rl, config);
        console.log('Saved Python application coverage.');
        break;
      case '3':
        await configureApplicationPythonRuntime(workspaceDir, rl, config);
        console.log('Saved default Python versions.');
        break;
      default:
        console.log('Unknown menu item.');
        break;
    }
  }
}

async function configureWorkspaceMenu(workspaceDir: string, rl: ReadlineInterface): Promise<void> {
  for (;;) {
    const config = await readMenuWorkspace(workspaceDir, rl);
    console.log('\nSettings');
    console.log('1. Registries and Gitea');
    console.log('2. Bundle directory');
    console.log('3. Download defaults');
    console.log('4. Publish defaults');
    console.log('5. Verify install defaults');
    console.log('6. Python / PyPI');
    console.log('7. Saved credentials');
    console.log('8. Show current config');
    console.log('0. Back');

    const choice = await ask(rl, 'Choose an action', '0');
    switch (choice) {
      case '0':
        return;
      case '1':
        await configureConnectionSettings(workspaceDir, rl, config);
        console.log('Saved workspace configuration.');
        break;
      case '2':
        await configureBundleDirectory(workspaceDir, rl, config);
        console.log('Saved workspace configuration.');
        break;
      case '3':
        await configureDownloadDefaults(workspaceDir, rl, config);
        console.log('Saved workspace configuration.');
        break;
      case '4':
        await configurePublishDefaults(workspaceDir, rl, config);
        console.log('Saved workspace configuration.');
        break;
      case '5':
        await configureVerifyInstallDefaults(workspaceDir, rl, config);
        console.log('Saved workspace configuration.');
        break;
      case '6':
        await configurePythonSettingsMenu(workspaceDir, rl);
        break;
      case '7':
        await configureCredentialsMenu(workspaceDir, rl);
        break;
      case '8':
        console.log(formatWorkspaceConfig(config));
        break;
      default:
        console.log('Unknown menu item.');
        break;
    }
  }
}

async function diagnosticsMenu(workspaceDir: string, rl: ReadlineInterface): Promise<void> {
  for (;;) {
    const config = await readMenuWorkspace(workspaceDir, rl);
    const bundle = config.output;

    console.log('\nDiagnostics');
    console.log('1. Verify bundle');
    console.log('2. Show bundle info');
    console.log('3. Check Gitea token');
    console.log('4. Prune stale bundle objects');
    console.log('0. Back');

    const choice = await ask(rl, 'Choose an action', '0');
    switch (choice) {
      case '0':
        return;
      case '1':
        await runSelfCommand(['verify', bundle], workspaceDir);
        break;
      case '2':
        await runSelfCommand(['info', bundle], workspaceDir);
        break;
      case '3': {
        const giteaUrl = await giteaUrlFromMenu(workspaceDir, rl);
        const token = await giteaTokenFromMenu(workspaceDir, rl);
        const login = await checkGiteaToken(giteaUrl, token);
        console.log(`Gitea token is valid for user: ${login}`);
        break;
      }
      case '4': {
        const dryRun = await askYesNo(rl, 'Dry run only?', true);
        await runSelfCommand(
          compactArgs(['bundle', 'prune', bundle, dryRun ? '--dry-run' : undefined]),
          workspaceDir
        );
        break;
      }
      default:
        console.log('Unknown menu item.');
    }
  }
}

async function npmRegistryTargetFromMenu(
  workspaceDir: string,
  rl: ReadlineInterface
): Promise<NpmRegistryTarget> {
  const config = await readMenuWorkspace(workspaceDir, rl);
  if (config.npmRegistry) {
    return config.npmRegistry;
  }
  const configured = await configureConnectionSettings(workspaceDir, rl, config);
  if (!configured.npmRegistry) {
    throw new Error('Closed-network npm registry target is required');
  }
  return configured.npmRegistry;
}

async function giteaUrlFromMenu(workspaceDir: string, rl: ReadlineInterface): Promise<string> {
  const config = await readMenuWorkspace(workspaceDir, rl);
  if (config.giteaUrl) {
    return config.giteaUrl;
  }

  const giteaUrl = await ask(rl, 'Closed-network Gitea URL', defaultWorkspaceGiteaUrl);
  if (!giteaUrl) {
    throw new Error('Closed-network Gitea URL is required');
  }
  await saveWorkspaceConfig(workspaceDir, { ...config, giteaUrl });
  return giteaUrl;
}

async function configureCredentialsMenu(
  workspaceDir: string,
  rl: ReadlineInterface
): Promise<void> {
  for (;;) {
    console.log('\nSaved credentials');
    console.log('1. Save Gitea token');
    console.log('2. Clear Gitea token');
    console.log('3. Check Gitea token');
    console.log('0. Back');

    const choice = await ask(rl, 'Choose an action', '0');
    switch (choice) {
      case '0':
        return;
      case '1': {
        const token = await ask(rl, 'Gitea token (visible input)');
        if (!token) {
          throw new Error('Gitea token is required');
        }
        await saveWorkspaceGiteaToken(workspaceDir, token);
        console.log(`Saved Gitea token in ${workspaceSecretsFileName}.`);
        break;
      }
      case '2':
        await clearWorkspaceGiteaToken(workspaceDir);
        console.log(`Cleared Gitea token from ${workspaceSecretsFileName}.`);
        break;
      case '3': {
        const config = await readMenuWorkspace(workspaceDir, rl);
        const giteaUrl = await ask(
          rl,
          'Closed-network Gitea URL',
          config.giteaUrl ?? defaultWorkspaceGiteaUrl
        );
        const token = await giteaTokenFromMenu(workspaceDir, rl);
        const login = await checkGiteaToken(giteaUrl, token);
        console.log(`Gitea token is valid for user: ${login}`);
        break;
      }
      default:
        console.log('Unknown menu item.');
    }
  }
}

async function runMenuAction(
  workspaceDir: string,
  choice: string,
  rl: ReadlineInterface
): Promise<boolean> {
  const config = await readMenuWorkspace(workspaceDir, rl);
  const bundle = config.output;

  switch (choice) {
    case '0':
      return false;
    case '1':
      await configureTargetsMenu(workspaceDir, rl);
      return true;
    case '2': {
      const includeDev = await resolvePromptBoolean(
        rl,
        'Include devDependencies?',
        config.defaults.download.includeDev,
        false
      );
      const includePeer = await resolvePromptBoolean(
        rl,
        'Traverse peerDependencies?',
        config.defaults.download.includePeer,
        false
      );
      const prune = await resolvePromptBoolean(
        rl,
        'Prune stale bundle objects after successful download?',
        config.defaults.download.prune,
        false
      );
      await runSelfCommand(
        compactArgs([
          'download',
          includeDev ? '--include-dev' : undefined,
          includePeer ? '--include-peer' : undefined,
          prune ? '--prune' : undefined,
        ]),
        workspaceDir
      );
      return true;
    }
    case '3': {
      console.error(`[menu] publish updates: bundle ${bundle}`);
      const npmRegistryTarget = await npmRegistryTargetFromMenu(workspaceDir, rl);
      const giteaUrl = await giteaUrlFromMenu(workspaceDir, rl);
      const targetRegistry = resolveNpmRegistryTarget(npmRegistryTarget, {
        giteaBaseUrl: giteaUrl,
      }).registryUrl;
      const provisionGit = await resolvePromptBoolean(
        rl,
        'Create/check missing Git repositories through Gitea API?',
        config.defaults.publish.provisionGit,
        true
      );
      const publicRepos = provisionGit
        ? await resolvePromptBoolean(
            rl,
            'Create public Gitea repositories?',
            config.defaults.publish.publicRepositories,
            false
          )
        : false;
      const configureGitGlobal = await resolvePromptBoolean(
        rl,
        'Configure global Git rewrites on this machine?',
        config.defaults.publish.configureGitGlobal,
        false
      );
      console.error(
        `[menu] publish updates: registry=${targetRegistry} gitea=${giteaUrl} public=${String(
          publicRepos
        )} provisionGit=${String(provisionGit)} configureGitGlobal=${String(configureGitGlobal)}`
      );
      const token =
        provisionGit || npmRegistryTarget.type === 'gitea'
          ? await giteaTokenFromMenu(workspaceDir, rl)
          : await resolveGiteaToken({
              cliToken: undefined,
              workspaceDir,
            });
      if (token) {
        console.error('[menu] publish updates: Gitea token is set');
      }
      await runSelfCommand(
        compactArgs([
          'publish',
          bundle,
          '--gitea',
          giteaUrl,
          publicRepos ? '--public' : undefined,
          provisionGit ? undefined : '--skip-git-provision',
          configureGitGlobal ? '--configure-git-global' : undefined,
        ]),
        workspaceDir,
        token ? { GITEA_TOKEN: token } : {}
      );
      return true;
    }
    case '4': {
      const npmRegistryTarget = await npmRegistryTargetFromMenu(workspaceDir, rl);
      const giteaUrl = await giteaUrlFromMenu(workspaceDir, rl);
      const targetRegistry = resolveNpmRegistryTarget(npmRegistryTarget, {
        giteaBaseUrl: giteaUrl,
      }).registryUrl;
      const ignoreScripts = await resolvePromptBoolean(
        rl,
        'Ignore lifecycle scripts during install verification?',
        config.defaults.verifyInstall.ignoreScripts,
        true
      );
      const registryToken =
        npmRegistryTarget.type === 'gitea'
          ? npmRegistryTarget.visibility === 'private'
            ? await giteaTokenFromMenu(workspaceDir, rl)
            : await resolveGiteaToken({ cliToken: undefined, workspaceDir })
          : undefined;
      await runSelfCommand(
        compactArgs([
          'verify',
          'install',
          bundle,
          '--registry',
          targetRegistry,
          '--gitea',
          giteaUrl,
          ignoreScripts ? '--ignore-scripts' : undefined,
        ]),
        workspaceDir,
        registryToken ? { GITEA_TOKEN: registryToken } : {}
      );
      return true;
    }
    case '5':
      await diagnosticsMenu(workspaceDir, rl);
      return true;
    case '6':
      await configureWorkspaceMenu(workspaceDir, rl);
      return true;
    default:
      console.log('Unknown menu item.');
      return true;
  }
}

async function runInteractiveMenu(workspace: string, options: MenuOptions): Promise<void> {
  const workspaceDir = path.resolve(workspace);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await readMenuWorkspace(workspaceDir, rl);
    const runOnce = async (): Promise<boolean> => {
      printMenu();
      const choice = await ask(rl, 'Choose an action', '0');
      try {
        return await runMenuAction(workspaceDir, choice, rl);
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exitCode = 1;
        return true;
      }
    };

    let keepGoing = await runOnce();
    while (keepGoing && options.once !== true) {
      keepGoing = await runOnce();
    }
  } finally {
    rl.close();
  }
}

const program = new Command();

program
  .name(packageName)
  .description('Sync Git, npm, and Python applications for airgapped environments')
  .version(packageVersion);

program
  .command('init')
  .description('Create an airgap-sync workspace on portable media')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--force', 'Overwrite an existing airgap-sync.json')
  .action(async (workspace: string, options: InitOptions) => {
    try {
      const config = await initWorkspace({
        force: options.force === true,
        workspaceDir: workspace,
      });
      console.log(
        JSON.stringify(
          {
            config,
            workspace: path.resolve(workspace),
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('menu')
  .description('Open an interactive workspace menu')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--once', 'Run one selected action and exit')
  .action(async (workspace: string, options: MenuOptions) => {
    try {
      await runInteractiveMenu(workspace, options);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('migrate')
  .description('Preview migration of a workspace to the current schema')
  .argument('[workspace]', 'Workspace directory', '.')
  .requiredOption('--dry-run', 'Print the schema-v2 workspace without writing it')
  .action(async (workspace: string) => {
    try {
      console.log(JSON.stringify(await previewWorkspaceMigration(workspace), null, 2));
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const coverageCommand = program
  .command('coverage')
  .description('Inspect broad Python platform coverage');

coverageCommand
  .command('list')
  .description('List built-in platform families and workspace coverage policies')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--json', 'Print machine-readable JSON')
  .action(async (workspace: string, options: CoverageOptions) => {
    try {
      const config = await readWorkspaceConfig(workspace);
      const result = {
        platformFamilies: listBuiltInPlatformFamilies(),
        policies: config.coveragePolicies ?? [],
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('Built-in platform families:');
        for (const family of result.platformFamilies) {
          console.log(`- ${family.id}: ${family.os}/${family.architecture}`);
        }
        console.log('Workspace coverage policies:');
        if (result.policies.length === 0) {
          console.log('- none');
        } else {
          for (const policy of result.policies) {
            console.log(`- ${policy.id}: ${policy.platforms.join(', ')}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

coverageCommand
  .command('show')
  .description('Show a platform family or workspace coverage policy')
  .argument('<id>', 'Platform family or coverage policy id')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--json', 'Print machine-readable JSON')
  .action(async (id: string, workspace: string, options: CoverageOptions) => {
    try {
      const config = await readWorkspaceConfig(workspace);
      const policy = config.coveragePolicies?.find((candidate) => candidate.id === id);
      const family = policy ? undefined : getBuiltInPlatformFamily(id);
      if (!policy && !family) {
        throw new Error(`Unknown coverage policy or platform family: ${id}`);
      }
      const result = policy ? { kind: 'policy', policy } : { family, kind: 'platform-family' };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (policy) {
        console.log(formatCoverageExplanation(policy));
      } else {
        console.log(
          `${family!.id}: ${family!.os}/${family!.architecture}\nStatus: ${family!.status}\nWheel platform families: ${family!.wheelPlatformFamilies.join(', ')}`
        );
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

coverageCommand
  .command('explain')
  .description('Explain a coverage policy with optional distribution examples')
  .argument('<id>', 'Platform family or coverage policy id')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--json', 'Print machine-readable JSON')
  .action(async (id: string, workspace: string, options: CoverageOptions) => {
    try {
      const config = await readWorkspaceConfig(workspace);
      const explanation = explainPlatformCoveragePolicy(findCoveragePolicy(config, id));
      console.log(
        options.json
          ? JSON.stringify(explanation, null, 2)
          : formatCoverageExplanation(findCoveragePolicy(config, id))
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('plan')
  .description('Resolve Python applications for their requested platform coverage')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--update <target>', 'Replan one target by one-based index or package name')
  .option('--cutoff <timestamp>', 'Ignore artifacts uploaded after this ISO timestamp')
  .option('--uv-bin <path>', 'Use an existing pinned uv executable')
  .option(
    '--retry-delays-ms <list>',
    'Comma-separated retry delays for transient network errors',
    parseRetryDelaysMs
  )
  .option('--json', 'Print machine-readable environment plans')
  .action(async (workspace: string, options: PlanOptions) => {
    const workspaceDir = path.resolve(workspace);
    try {
      const config = await readWorkspaceConfig(workspaceDir);
      const targets = config.targets.flatMap((target, index) =>
        target.type === 'python-app' ? [{ index: index + 1, target }] : []
      );
      if (targets.length === 0) {
        throw new Error('No python-app targets are configured');
      }
      const selected = options.update
        ? targets.filter(
            ({ index, target }) =>
              String(index) === options.update || target.spec === options.update
          )
        : targets;
      if (selected.length === 0) {
        throw new Error(`No python-app target matches: ${options.update ?? ''}`);
      }
      const results = await planWorkspacePythonApplications({
        config,
        ...(options.cutoff ? { cutoff: options.cutoff } : {}),
        ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
        targetIndexes: selected.map(({ index }) => index),
        ...(options.uvBin ? { uvBin: options.uvBin } : {}),
        workspaceDir,
      });
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(
          results
            .map(
              (result) =>
                `Target ${String(result.index)} (${result.targetId})\n${formatPythonApplicationPlan(result.plan)}\n${formatPythonPlanDiff(result.diff)}`
            )
            .join('\n\n')
        );
      }
    } catch (error) {
      if (error instanceof PythonApplicationPlanningError) {
        printPythonPlanningError(error, options.json === true);
      } else {
        console.error(`Error: ${(error as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

program
  .command('probe')
  .description('Compare this machine with a Python environment plan')
  .requiredOption('--compare <plan>', 'Environment plan JSON path')
  .option(
    '--capability <name=value>',
    'Declare an explicitly requested feature capability',
    collectStrings,
    []
  )
  .option('--facts <json>', 'Read facts emitted by a standalone probe script')
  .option('--json', 'Print machine-readable JSON')
  .action(async (options: ProbeOptions) => {
    try {
      const rawPlan = JSON.parse(
        await readFile(path.resolve(options.compare), 'utf8')
      ) as PythonEnvironmentPlanInput;
      const plan = createPythonEnvironmentPlan(rawPlan);
      const capabilities = parseCapabilities(options.capability);
      const facts = options.facts
        ? normalizeMachineProbeFacts(
            JSON.parse(await readFile(path.resolve(options.facts), 'utf8'))
          )
        : await probeMachine({ capabilities });
      Object.assign(facts.capabilities, capabilities);
      const comparison = compareMachineToPythonEnvironmentPlan(facts, plan);
      console.log(
        options.json ? JSON.stringify(comparison, null, 2) : formatProbeComparison(comparison)
      );
      if (comparison.status === 'incompatible') {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const targetCommand = program.command('target').description('Manage workspace sync targets');

targetCommand
  .command('list')
  .description('List targets from airgap-sync.json')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (workspace: string) => {
    try {
      const config = await readWorkspaceConfig(workspace);
      console.log(formatTargetList(config.targets));
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const targetAddCommand = targetCommand.command('add').description('Add a workspace target');

targetAddCommand
  .command('git')
  .description('Add a Git repository target')
  .argument('<url>', 'Git repository URL')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--branch <name>', 'Branch to clone on first materialization')
  .action(async (url: string, workspace: string, options: TargetGitOptions) => {
    try {
      const target = {
        ...(options.branch ? { branch: options.branch } : {}),
        type: 'git' as const,
        url,
      };
      const result = await addWorkspaceTarget(workspace, target);
      console.log(
        `${result.added ? 'Added' : 'Already configured'} target: ${formatTargetValue(target)}\nTotal targets: ${String(result.config.targets.length)}`
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

targetAddCommand
  .command('python-app')
  .description('Add a Python application with broad platform coverage')
  .argument('<spec>', 'Python application package requirement')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--coverage <id>', 'Override the workspace default coverage policy')
  .option(
    '--platform <family>',
    'Inline platform family; repeat for additional families',
    collectStrings,
    []
  )
  .option('--version <specifier>', 'Application version constraint')
  .option(
    '--include-version <version>',
    'Exact application version or latest; repeat to include multiple alternatives',
    collectStrings,
    []
  )
  .option('--extra <name>', 'Application extra; repeat for additional extras', collectStrings, [])
  .option(
    '--feature <name=value>',
    'Explicit application feature; repeat for additional features',
    collectStrings,
    []
  )
  .option('--recipe <path>', 'Maintained application recipe inside the workspace')
  .option('--python <specifier>', 'Advanced Python version constraint')
  .option(
    '--python-version <minor>',
    'Override the workspace Python minors; repeat for multiple versions',
    collectStrings,
    []
  )
  .action(async (spec: string, workspace: string, options: TargetPythonApplicationOptions) => {
    try {
      const config = await readWorkspaceConfig(workspace);
      if (config.schemaVersion !== 2) {
        throw new Error('python-app targets require workspace schemaVersion 2');
      }
      if (options.coverage && (options.platform?.length ?? 0) > 0) {
        throw new Error('Use either --coverage or --platform, not both');
      }
      if (options.python && (options.pythonVersion?.length ?? 0) > 0) {
        throw new Error('Use either --python or --python-version, not both');
      }
      if (options.version && (options.includeVersion?.length ?? 0) > 0) {
        throw new Error('Use either --version or --include-version, not both');
      }
      const coverage =
        (options.platform?.length ?? 0) > 0
          ? {
              platforms: parsePythonApplicationPlatforms(options.platform ?? []),
              version: 1 as const,
              wheelStrategy: 'minimum-cover' as const,
            }
          : options.coverage;
      if (
        !coverage &&
        !config.python?.applicationDefaults?.coverage &&
        !config.coveragePolicies?.[0]
      ) {
        throw new Error(
          'No default Python application coverage is configured; use --platform or --coverage'
        );
      }
      const maintainedRecipe =
        options.recipe === undefined ? findMaintainedPythonApplicationRecipe(spec) : undefined;
      const recipe =
        options.recipe ??
        (maintainedRecipe
          ? await installMaintainedPythonApplicationRecipe(workspace, maintainedRecipe)
          : undefined);
      const target: WorkspacePythonApplicationTarget = {
        application: {
          extras: options.extra ?? [],
          features: parseCapabilities(options.feature ?? []),
          ...(recipe ? { recipe } : {}),
          ...(options.version ? { version: options.version } : {}),
          ...((options.includeVersion?.length ?? 0) > 0
            ? { versionSelection: parsePythonApplicationVersionSelection(options.includeVersion!) }
            : {}),
        },
        ...(coverage ? { coverage } : {}),
        ...((options.pythonVersion?.length ?? 0) > 0
          ? { python: { policy: 'selected' as const, versions: options.pythonVersion! } }
          : options.python
            ? { python: { policy: 'constrained' as const, version: options.python } }
            : {}),
        spec,
        type: 'python-app',
      };
      const result = await addWorkspaceTarget(workspace, target);
      const resolved = resolveWorkspacePythonApplication(result.config, target);
      console.log(
        `${result.added ? 'Added' : 'Already configured'} target: ${formatTargetValue(target)}\nCoverage: ${
          resolved.coveragePolicy.id
        } (${resolved.coveragePolicy.platforms.join(', ')})\nPython runtime: ${formatPythonRuntimePolicy(resolved.intent.python)}${
          recipe ? `\nRecipe: ${recipe}` : ''
        }\nTotal targets: ${String(result.config.targets.length)}`
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

targetAddCommand
  .command('cpython-distributions')
  .description('Add a rolling set of portable CPython distributions')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--from-minor <version>', 'Lowest CPython minor, e.g. 3.10', '3.10')
  .option(
    '--platform <id>',
    'Platform family; repeatable, defaults to every supported platform',
    collectStrings,
    []
  )
  .option(
    '--latest <count>',
    'Latest patch versions retained per minor and platform',
    parsePositiveInteger,
    1
  )
  .option(
    '--window-days <days>',
    'Provider build history retained as fixed 24-hour days',
    parsePositiveInteger,
    365
  )
  .action(async (workspace: string, options: TargetCpythonDistributionsOptions) => {
    try {
      const platforms =
        options.platform.length > 0
          ? options.platform
          : listBuiltInPlatformFamilies()
              .filter((platform) => platform.status === 'supported')
              .map((platform) => platform.id);
      const target = {
        builds: { windowDays: options.windowDays },
        patches: { latest: options.latest },
        platforms: platforms as ('linux-glibc-x86_64' | 'windows-x86_64')[],
        provider: 'python-build-standalone',
        series: { from: options.fromMinor, major: 3, through: 'latest-stable' },
        type: 'cpython-distributions',
      } as const;
      const result = await addWorkspaceTarget(workspace, target);
      console.log(
        `${result.added ? 'Added' : 'Already configured'} target: ${formatTargetValue(target)}\nTotal targets: ${String(result.config.targets.length)}`
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

targetAddCommand
  .command('npm')
  .description('Add an npm package spec target')
  .argument('<spec>', 'Package spec, e.g. eslint@latest')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (spec: string, workspace: string) => {
    try {
      const result = await addWorkspaceTarget(workspace, {
        spec,
        type: 'npm',
      });
      console.log(
        `${result.added ? 'Added' : 'Already configured'} target: ${formatTargetValue({
          spec,
          type: 'npm',
        })}\nTotal targets: ${String(result.config.targets.length)}`
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const secretsCommand = program
  .command('secrets')
  .description(`Manage local secrets in ${workspaceSecretsFileName}`);

secretsCommand
  .command('status')
  .description('Show whether local workspace secrets are configured')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (workspace: string) => {
    try {
      const secrets = await readWorkspaceSecrets(workspace);
      console.log(
        JSON.stringify(
          {
            giteaToken: secrets.giteaToken ? 'saved' : 'missing',
            secretsFile: path.resolve(workspace, workspaceSecretsFileName),
            workspace: path.resolve(workspace),
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

secretsCommand
  .command('set-gitea-token')
  .description('Save a Gitea token in the local workspace secrets file')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (workspace: string) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const token = await ask(rl, 'Gitea token (visible input)');
      if (!token) {
        throw new Error('Gitea token is required');
      }
      await saveWorkspaceGiteaToken(workspace, token);
      console.log(`Saved Gitea token in ${path.resolve(workspace, workspaceSecretsFileName)}.`);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      rl.close();
    }
  });

secretsCommand
  .command('clear-gitea-token')
  .description('Remove the saved Gitea token from the local workspace secrets file')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (workspace: string) => {
    try {
      await clearWorkspaceGiteaToken(workspace);
      console.log(`Cleared Gitea token from ${path.resolve(workspace, workspaceSecretsFileName)}.`);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

secretsCommand
  .command('check-gitea-token')
  .description('Validate the saved or provided Gitea token')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--gitea <url>', 'Closed-network Gitea base URL; defaults to airgap-sync.json')
  .option('--token <token>', `Gitea token, defaults to GITEA_TOKEN or ${workspaceSecretsFileName}`)
  .action(async (workspace: string, options: SecretsCheckOptions) => {
    try {
      const config = options.gitea ? undefined : await readWorkspaceConfig(workspace);
      const giteaUrl = options.gitea ?? config?.giteaUrl;
      if (!giteaUrl) {
        throw new Error('provide --gitea <url> or configure giteaUrl in airgap-sync.json');
      }
      const token = await requireGiteaToken({
        cliToken: options.token,
        optionName: '--token <token>',
        workspaceDir: workspace,
      });
      const login = await checkGiteaToken(giteaUrl, token);
      console.log(
        JSON.stringify(
          {
            giteaUrl,
            ok: true,
            user: login,
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

targetCommand
  .command('edit')
  .description('Edit the supported settings of a workspace target')
  .argument('<index>', 'Target index from target list')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--branch <name>', 'Replace a Git target branch')
  .option('--clear-branch', 'Remove an explicit Git target branch')
  .option('--coverage <id>', 'Override a Python application coverage policy')
  .option('--from-minor <version>', 'Replace the lowest CPython minor')
  .option('--inherit-coverage', 'Use workspace default coverage for a Python application')
  .option('--inherit-python', 'Use workspace default Python versions for an application')
  .option(
    '--platform <id>',
    'Replace CPython platform families; repeat for additional families',
    collectOptionalStrings
  )
  .option('--latest <count>', 'Replace CPython patch depth', parsePositiveInteger)
  .option(
    '--window-days <days>',
    'Replace the CPython provider-build window in fixed 24-hour days',
    parsePositiveInteger
  )
  .option(
    '--include-version <version>',
    'Replace Python application exact/latest selectors; repeat for alternatives',
    collectOptionalStrings
  )
  .option('--python <specifier>', 'Override a Python application runtime constraint')
  .option(
    '--python-version <minor>',
    'Override Python application minors; repeat for multiple versions',
    collectOptionalStrings
  )
  .action(async (index: string, workspace: string, options: TargetEditOptions) => {
    try {
      if (options.branch !== undefined && options.clearBranch === true) {
        throw new Error('Use either --branch or --clear-branch, not both');
      }
      if (options.coverage !== undefined && options.inheritCoverage === true) {
        throw new Error('Use either --coverage or --inherit-coverage, not both');
      }
      if (options.python !== undefined && options.pythonVersion !== undefined) {
        throw new Error('Use either --python or --python-version, not both');
      }
      if (
        options.inheritPython === true &&
        (options.python !== undefined || options.pythonVersion !== undefined)
      ) {
        throw new Error('Use a Python override or --inherit-python, not both');
      }
      const edit: WorkspaceTargetEdit = {
        ...(options.branch !== undefined ? { branch: options.branch } : {}),
        ...(options.clearBranch === true ? { branch: null } : {}),
        ...(options.coverage !== undefined ? { coverage: options.coverage } : {}),
        ...(options.inheritCoverage === true ? { coverage: null } : {}),
        ...(options.fromMinor !== undefined ? { fromMinor: options.fromMinor } : {}),
        ...(options.includeVersion !== undefined
          ? { versionSelection: parsePythonApplicationVersionSelection(options.includeVersion) }
          : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
        ...(options.platform !== undefined
          ? { platforms: parsePythonApplicationPlatforms(options.platform) }
          : {}),
        ...(options.pythonVersion !== undefined
          ? { python: { policy: 'selected' as const, versions: options.pythonVersion } }
          : options.python !== undefined
            ? { python: { policy: 'constrained' as const, version: options.python } }
            : {}),
        ...(options.inheritPython === true ? { python: null } : {}),
        ...(options.windowDays !== undefined ? { windowDays: options.windowDays } : {}),
      };
      const result = await editWorkspaceTarget(workspace, parsePositiveInteger(index), edit);
      console.log(
        `${result.changed ? 'Updated' : 'Unchanged'} target: ${formatTargetValue(result.target)}\nTotal targets: ${String(result.config.targets.length)}`
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

targetCommand
  .command('set-python-app-versions')
  .description('Deprecated alias for target edit --include-version')
  .argument('<index>', 'Target index from target list')
  .argument('[workspace]', 'Workspace directory', '.')
  .option(
    '--include-version <version>',
    'Exact application version or latest; repeat to include multiple alternatives',
    collectStrings,
    []
  )
  .action(async (index: string, workspace: string, options: { includeVersion?: string[] }) => {
    try {
      const result = await setWorkspacePythonApplicationVersionSelection(
        workspace,
        parsePositiveInteger(index),
        parsePythonApplicationVersionSelection(options.includeVersion ?? [])
      );
      console.log(
        `Updated target: ${formatTargetValue(result.target)}\nTotal targets: ${String(result.config.targets.length)}`
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

targetCommand
  .command('remove')
  .description('Remove a target by its one-based list index')
  .argument('<index>', 'Target index from target list')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (index: string, workspace: string) => {
    try {
      const result = await removeWorkspaceTarget(workspace, parsePositiveInteger(index));
      console.log(
        `Removed target: ${formatTargetValue(result.removed)}\nTotal targets: ${String(
          result.config.targets.length
        )}`
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('download')
  .description('Download updates into an airgap bundle')
  .argument('[root]', 'Directory containing project Git repositories or package manifests')
  .option('-o, --output <dir>', 'Bundle output directory')
  .option('-r, --registry <url>', 'Source registry URL')
  .option('--include-dev', 'Include root devDependencies')
  .option('--include-peer', 'Traverse peerDependencies')
  .option(
    '--min-release-age-days <days>',
    'Quarantine npm releases newer than this many days (0 disables)',
    parseNonNegativeInteger
  )
  .option(
    '--max-security-report-age-hours <hours>',
    'Maximum accepted age of an OSV security report',
    parsePositiveInteger
  )
  .option(
    '--allow-package <identity>',
    'Allow static findings only for name@version#sha256:digest; repeatable',
    collectOptionalStrings
  )
  .option(
    '--vulnerability-resolution-policy <policy>',
    'Unpinned range policy: prefer-clean or report-only',
    parseVulnerabilityResolutionPolicy
  )
  .option(
    '--allow-window-gap',
    'Continue when the last successful full download is older than a configured artifact window'
  )
  .option(
    '--latest-policy <policy>',
    'Latest dist-tag policy: bundled or source',
    parseLatestPolicy
  )
  .option(
    '--tag-resolution-policy <policy>',
    'Tag dependency policy: reuse-stable or refresh',
    parseTagResolutionPolicy
  )
  .option(
    '--range-resolution-policy <policy>',
    'Range dependency policy: reuse-stable or refresh',
    parseRangeResolutionPolicy
  )
  .option(
    '--concurrency <count>',
    'Parallel npm, Git, and Python operations',
    parsePositiveInteger,
    8
  )
  .option(
    '--registry-timeout-ms <ms>',
    'Timeout for npm registry metadata requests',
    parsePositiveInteger
  )
  .option(
    '--tarball-timeout-ms <ms>',
    'No-progress timeout for npm tarball downloads',
    parsePositiveInteger
  )
  .option(
    '--target <index>',
    'Only download the selected workspace target by one-based target list index; repeatable',
    collectNumbers,
    []
  )
  .option(
    '--retry-delays-ms <list>',
    'Comma-separated retry delays for transient network errors',
    parseRetryDelaysMs
  )
  .option('--dry-run', 'Resolve and report without pulling, downloading, or cloning')
  .option('--prune', 'Remove stale npm, Python, and Git objects after a successful download')
  .option('--json', 'Print the full JSON report instead of the concise summary')
  .action(async (root: string | undefined, options: CollectOptions) => {
    const startedAt = performance.now();
    try {
      validateDownloadInvocation(root, options.target);
      if (!root) {
        const workspaceDir = process.cwd();
        const config = await readWorkspaceConfig(workspaceDir);
        const targetSelection =
          options.target && options.target.length > 0
            ? selectWorkspaceTargets(config, options.target)
            : undefined;
        const activeConfig = targetSelection?.config ?? config;
        const outputDir = path.resolve(workspaceDir, options.output ?? config.output);
        const lastSuccessfulDownload = await reportDownloadWatermark(outputDir);
        await confirmCpythonWindowGap({
          ...(options.allowWindowGap === undefined
            ? {}
            : { allowWindowGap: options.allowWindowGap }),
          config: activeConfig,
          lastSuccessfulDownload,
          ...(targetSelection ? { targetIndexes: targetSelection.selectedIndexes } : {}),
        });
        if (targetSelection) {
          console.error(
            `[download] selected targets: ${targetSelection.selectedIndexes.join(', ')}`
          );
          if (options.prune === true || config.defaults.download.prune === true) {
            console.error(
              '[download] prune skipped: --target downloads do not prune shared bundles'
            );
          }
        }
        const parsedTargets = parseRootSpecs(
          activeConfig.targets
            .filter((target) => target.type === 'npm')
            .map((target) => target.spec)
        );
        const gitTargets = createWorkspaceGitSources(activeConfig);
        const cpythonTargets = activeConfig.targets.filter(
          (target) => target.type === 'cpython-distributions'
        );
        const pythonApplicationPreflight = await ensureWorkspacePythonApplicationPlans({
          config,
          onPlanRequired: (requirements) => {
            console.error(
              `[download] planning Python applications: ${requirements
                .map(
                  (requirement) =>
                    `${requirement.targetId} (${requirement.reason === 'stale' ? 'configuration changed' : 'plan missing'})`
                )
                .join(', ')}`
            );
          },
          planTargets: async (targetIndexes) => {
            if (options.dryRun === true) {
              throw new Error(
                'Python application planning is required; rerun download without --dry-run or run airgap-sync plan first'
              );
            }
            const results = await planWorkspacePythonApplications({
              config,
              ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
              targetIndexes,
              workspaceDir,
            });
            for (const result of results) {
              console.error(
                `[download] planned Python application ${result.targetId}: ${result.plan.application.version}`
              );
            }
          },
          readRecipe: async (target) => await readWorkspacePythonRecipe(workspaceDir, target),
          ...(targetSelection ? { targetIndexes: targetSelection.selectedIndexes } : {}),
          workspaceDir,
        });
        const pythonApplicationPlans = pythonApplicationPreflight.targets.map(
          ({ activePlan, selectionId, targetId }) => ({ activePlan, selectionId, targetId })
        );
        const registryUrl = options.registry ?? config.sourceRegistry;
        const includeDev =
          options.includeDev === true ? true : config.defaults.download.includeDev === true;
        const includePeer =
          options.includePeer === true ? true : config.defaults.download.includePeer === true;
        const latestPolicy = options.latestPolicy ?? config.defaults.download.latestPolicy;
        const rangeResolutionPolicy =
          options.rangeResolutionPolicy ?? config.defaults.download.rangeResolutionPolicy;
        const tagResolutionPolicy =
          options.tagResolutionPolicy ?? config.defaults.download.tagResolutionPolicy;
        const npmSecurity = {
          allowPackages:
            options.allowPackage ??
            activeConfig.npmSecurity?.allowPackages ??
            defaultNpmSecurityPolicy.allowPackages,
          maxReportAgeHours:
            options.maxSecurityReportAgeHours ??
            activeConfig.npmSecurity?.maxReportAgeHours ??
            defaultNpmSecurityPolicy.maxReportAgeHours,
          minReleaseAgeDays:
            options.minReleaseAgeDays ??
            activeConfig.npmSecurity?.minReleaseAgeDays ??
            defaultNpmSecurityPolicy.minReleaseAgeDays,
          vulnerabilityResolutionPolicy:
            options.vulnerabilityResolutionPolicy ??
            activeConfig.npmSecurity?.vulnerabilityResolutionPolicy ??
            defaultNpmSecurityPolicy.vulnerabilityResolutionPolicy,
        };
        const osvClient = new OsvBatchClient();
        const npmAdvisoryClient = new OsvNpmAdvisoryClient(osvClient);
        const pythonAdvisoryClient = new OsvPythonAdvisoryClient(osvClient);
        const prune =
          !targetSelection && (options.prune === true || config.defaults.download.prune === true);
        const snapshotOutput = options.output
          ? path.relative(workspaceDir, outputDir) || '.'
          : config.output;
        const registry = new CachedRegistryClient(
          new HttpRegistryClient(registryUrl, {
            ...(options.registryTimeoutMs ? { timeoutMs: options.registryTimeoutMs } : {}),
            ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
          })
        );
        const beforeState =
          options.dryRun === true ? undefined : await captureBundleState(outputDir);
        const retainedGitSources =
          targetSelection && (await fileExists(path.join(outputDir, 'git-sources.json')))
            ? (await readGitSourcesManifest(outputDir)).sources
            : undefined;
        const onDownloadProgress = createCollectProgressLogger();
        const report = await collectBundle({
          dryRun: options.dryRun === true,
          concurrency: options.concurrency,
          deferGitSourcesActivation: true,
          includeDev,
          includePeer,
          initialGitRequirements: parsedTargets.gitRequirements,
          initialGitSources: gitTargets,
          initialRequirements: parsedTargets.requirements,
          initialUnsupported: parsedTargets.unsupported,
          latestPolicy,
          minReleaseAgeDays: npmSecurity.minReleaseAgeDays,
          rangeResolutionPolicy,
          ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
          tagResolutionPolicy,
          ...(options.tarballTimeoutMs ? { tarballTimeoutMs: options.tarballTimeoutMs } : {}),
          onProgress: onDownloadProgress,
          outputDir,
          registry,
          registryUrl,
          security: {
            advisoryClient: npmAdvisoryClient,
            policy: {
              ...npmSecurity,
            },
          },
          ...(retainedGitSources ? { retainedGitSources } : {}),
        });
        if (pythonApplicationPlans.length > 0 || targetSelection === undefined) {
          report.pythonApplications = await downloadPythonApplicationPlans({
            bundleDir: outputDir,
            concurrency: options.concurrency,
            dryRun: options.dryRun === true,
            generatedAt: report.generatedAt,
            ...(activeConfig.giteaUrl ? { giteaBaseUrl: activeConfig.giteaUrl } : {}),
            onProgress: (event) => {
              onDownloadProgress({ ...event, phase: 'python-application-fetch' });
            },
            partial: targetSelection !== undefined,
            ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
            targets: pythonApplicationPlans,
            validateCandidate: async ({ manifest: candidateManifest }) => {
              onDownloadProgress({ phase: 'python-security-scan', status: 'start' });
              const pythonSecurity = await scanPythonBundleSecurity({
                advisoryClient: pythonAdvisoryClient,
                generatedAt: report.generatedAt,
                manifest: candidateManifest,
                policy: { maxReportAgeHours: npmSecurity.maxReportAgeHours },
              });
              report.pythonSecurity = pythonSecurity;
              await writePythonSecurityReport(outputDir, pythonSecurity, {
                failed: !pythonSecurity.ok,
              });
              onDownloadProgress({
                current: pythonSecurity.packageCount,
                phase: 'python-security-scan',
                status: pythonSecurity.ok ? 'done' : 'error',
                total: pythonSecurity.packageCount,
              });
              if (!pythonSecurity.ok) {
                report.wroteBundle = false;
                throw new Error('known-malware scan did not pass');
              }
            },
          });
        }
        if (
          cpythonTargets.length > 0 ||
          (targetSelection === undefined &&
            (await fileExists(path.join(outputDir, cpythonDistributionIndexPath))))
        ) {
          report.cpythonDistributions = await downloadCpythonDistributionBundle({
            bundleDir: outputDir,
            concurrency: options.concurrency,
            dryRun: options.dryRun === true,
            generatedAt: report.generatedAt,
            onDiscoveryPage: (event) => {
              console.error(
                `[download] CPython discovery page ${String(event.page)}: ${String(event.candidates)} matching artifacts`
              );
            },
            onDiscoveryRetry: (event) => {
              const reason =
                event.error instanceof Error ? event.error.message : String(event.error);
              console.error(
                `[download] CPython discovery ${event.phase}${event.page === undefined ? '' : ` page ${String(event.page)}`} attempt ${String(event.attempt)} failed: ${reason}; retrying with attempt ${String(event.nextAttempt)} in ${String(event.delayMs)}ms`
              );
            },
            partial: targetSelection !== undefined,
            ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
            targets: cpythonTargets,
          });
        }
        const securityDeltas =
          options.dryRun === true
            ? {}
            : await createDownloadSecurityDeltas(outputDir, report, beforeState);
        if (options.dryRun !== true) {
          await writeCollectReport(outputDir, report);
        }
        const workspaceSnapshot = createWorkspaceSnapshot({
          config: {
            ...config,
            output: snapshotOutput,
            sourceRegistry: registryUrl,
          },
          createdAt: report.generatedAt,
        });
        const activateDownload =
          options.dryRun !== true && report.wroteBundle && !collectShouldFail(report);
        if (activateDownload) {
          await writeGitSourcesManifest(outputDir, report.gitSources);
          await writeWorkspaceSnapshot(outputDir, workspaceSnapshot);
        }

        const pruneReport =
          prune && options.dryRun !== true ? await pruneAfterSuccessfulDownload(report) : undefined;
        if (pruneReport?.errors.length === 0) {
          const removedPlans = await pruneInactivePythonApplicationPlans(
            workspaceDir,
            pythonApplicationPreflight.targets.map(({ activePlan }) => activePlan.manifest.targetId)
          );
          if (removedPlans.length > 0) {
            console.error(
              `[prune] removed ${String(removedPlans.length)} inactive Python workspace plans`
            );
          }
        }
        if (beforeState) {
          await writeDownloadRunHistory({
            before: beforeState,
            bundleDir: outputDir,
            rangeResolutionPolicy,
            report,
            securityDeltas,
            ...(pruneReport ? { pruneReport } : {}),
            scope: targetSelection ? 'partial' : 'full',
            ...(targetSelection ? { selectedTargetIndexes: targetSelection.selectedIndexes } : {}),
            tagResolutionPolicy,
            workspaceSnapshot,
          });
        }

        if (options.json === true) {
          console.log(
            JSON.stringify(
              {
                workspaceSnapshot,
                ...(pruneReport ? { prune: pruneReport } : {}),
                securityDeltas,
                ...report,
              },
              null,
              2
            )
          );
        } else {
          console.log(formatDownloadSummary(report, securityDeltas));
          if (pruneReport) {
            console.log(formatPruneSummary(pruneReport));
          }
        }

        if (collectShouldFail(report)) {
          process.exitCode = 1;
        }
        return;
      }

      const registryUrl = options.registry ?? defaultWorkspaceSourceRegistry;
      const outputDir = options.output ?? './airgap-bundle';
      await reportDownloadWatermark(outputDir);
      const registry = new CachedRegistryClient(
        new HttpRegistryClient(registryUrl, {
          ...(options.registryTimeoutMs ? { timeoutMs: options.registryTimeoutMs } : {}),
          ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
        })
      );
      const beforeState = options.dryRun === true ? undefined : await captureBundleState(outputDir);
      const npmSecurity = {
        allowPackages: options.allowPackage ?? defaultNpmSecurityPolicy.allowPackages,
        maxReportAgeHours:
          options.maxSecurityReportAgeHours ?? defaultNpmSecurityPolicy.maxReportAgeHours,
        minReleaseAgeDays: options.minReleaseAgeDays ?? defaultNpmSecurityPolicy.minReleaseAgeDays,
        vulnerabilityResolutionPolicy:
          options.vulnerabilityResolutionPolicy ??
          defaultNpmSecurityPolicy.vulnerabilityResolutionPolicy,
      };
      const osvClient = new OsvBatchClient();
      const report = await collectBundle({
        dryRun: options.dryRun === true,
        concurrency: options.concurrency,
        includeDev: options.includeDev === true,
        includePeer: options.includePeer === true,
        latestPolicy: options.latestPolicy ?? 'bundled',
        minReleaseAgeDays: npmSecurity.minReleaseAgeDays,
        rangeResolutionPolicy: options.rangeResolutionPolicy ?? 'reuse-stable',
        ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
        tagResolutionPolicy: options.tagResolutionPolicy ?? 'reuse-stable',
        ...(options.tarballTimeoutMs ? { tarballTimeoutMs: options.tarballTimeoutMs } : {}),
        onProgress: createCollectProgressLogger(),
        outputDir,
        registry,
        registryUrl,
        security: {
          advisoryClient: new OsvNpmAdvisoryClient(osvClient),
          policy: {
            ...npmSecurity,
          },
        },
        root,
      });
      const securityDeltas =
        options.dryRun === true
          ? {}
          : await createDownloadSecurityDeltas(outputDir, report, beforeState);
      const pruneReport =
        options.prune === true && options.dryRun !== true
          ? await pruneAfterSuccessfulDownload(report)
          : undefined;
      if (beforeState) {
        await writeDownloadRunHistory({
          before: beforeState,
          bundleDir: outputDir,
          rangeResolutionPolicy: options.rangeResolutionPolicy ?? 'reuse-stable',
          report,
          securityDeltas,
          ...(pruneReport ? { pruneReport } : {}),
          tagResolutionPolicy: options.tagResolutionPolicy ?? 'reuse-stable',
        });
      }

      if (options.json === true) {
        console.log(
          JSON.stringify(
            { ...(pruneReport ? { prune: pruneReport } : {}), securityDeltas, ...report },
            null,
            2
          )
        );
      } else {
        console.log(formatDownloadSummary(report, securityDeltas));
        if (pruneReport) {
          console.log(formatPruneSummary(pruneReport));
        }
      }

      if (collectShouldFail(report)) {
        process.exitCode = 1;
      }
    } catch (error) {
      if (error instanceof PythonApplicationPlanningError) {
        printPythonPlanningError(error, options.json === true);
      } else {
        console.error(`Error: ${(error as Error).message}`);
      }
      process.exitCode = 1;
    } finally {
      printTotalElapsedTime(startedAt, options.json === true);
    }
  });

program
  .command('fetch')
  .description('Resolve dependencies and build an airgap bundle')
  .argument('[specs...]', 'Package specs to seed, e.g. react@latest')
  .option('-o, --output <dir>', 'Bundle output directory', './airgap-bundle')
  .option('-r, --registry <url>', 'Source registry URL', 'https://registry.npmjs.org')
  .option('--manifest <path>', 'Read root dependencies from a package.json')
  .option('--include-dev', 'Include root devDependencies')
  .option('--include-peer', 'Traverse peerDependencies')
  .option(
    '--min-release-age-days <days>',
    'Quarantine npm releases newer than this many days (0 disables)',
    parseNonNegativeInteger
  )
  .option(
    '--max-security-report-age-hours <hours>',
    'Maximum accepted age of an OSV security report',
    parsePositiveInteger
  )
  .option(
    '--allow-package <identity>',
    'Allow static findings only for name@version#sha256:digest; repeatable',
    collectOptionalStrings
  )
  .option(
    '--vulnerability-resolution-policy <policy>',
    'Unpinned range policy: prefer-clean or report-only',
    parseVulnerabilityResolutionPolicy
  )
  .option(
    '--latest-policy <policy>',
    'Latest dist-tag policy: bundled or source',
    parseLatestPolicy,
    'bundled'
  )
  .option(
    '--tag-resolution-policy <policy>',
    'Tag dependency policy: reuse-stable or refresh',
    parseTagResolutionPolicy,
    'reuse-stable'
  )
  .option(
    '--range-resolution-policy <policy>',
    'Range dependency policy: reuse-stable or refresh',
    parseRangeResolutionPolicy,
    'reuse-stable'
  )
  .option('--concurrency <count>', 'Parallel npm resolve/download workers', parsePositiveInteger, 8)
  .option(
    '--registry-timeout-ms <ms>',
    'Timeout for npm registry metadata requests',
    parsePositiveInteger
  )
  .option(
    '--tarball-timeout-ms <ms>',
    'No-progress timeout for npm tarball downloads',
    parsePositiveInteger
  )
  .option(
    '--retry-delays-ms <list>',
    'Comma-separated retry delays for transient network errors',
    parseRetryDelaysMs
  )
  .option('--dry-run', 'Resolve and report without downloading')
  .action(async (specs: string[], options: FetchOptions) => {
    if (specs.length === 0 && !options.manifest) {
      console.error('Error: provide at least one package spec or --manifest <path>');
      process.exitCode = 1;
      return;
    }

    const parsedSpecs = parseRootSpecs(specs);
    const parsedManifest = options.manifest
      ? await readManifestRequirements(options.manifest, {
          includeDev: options.includeDev === true,
          includePeer: options.includePeer === true,
        })
      : { gitRequirements: [], requirements: [], unsupported: [] };
    const requirements = [...parsedSpecs.requirements, ...parsedManifest.requirements];
    const unsupported = [...parsedSpecs.unsupported, ...parsedManifest.unsupported];
    const gitRequirements = [...parsedSpecs.gitRequirements, ...parsedManifest.gitRequirements];
    const latestPolicy = options.latestPolicy ?? 'bundled';
    const rangeResolutionPolicy = options.rangeResolutionPolicy ?? 'reuse-stable';
    const tagResolutionPolicy = options.tagResolutionPolicy ?? 'reuse-stable';
    const npmSecurity = {
      allowPackages: options.allowPackage ?? defaultNpmSecurityPolicy.allowPackages,
      maxReportAgeHours:
        options.maxSecurityReportAgeHours ?? defaultNpmSecurityPolicy.maxReportAgeHours,
      minReleaseAgeDays: options.minReleaseAgeDays ?? defaultNpmSecurityPolicy.minReleaseAgeDays,
      vulnerabilityResolutionPolicy:
        options.vulnerabilityResolutionPolicy ??
        defaultNpmSecurityPolicy.vulnerabilityResolutionPolicy,
    };
    const osvClient = new OsvBatchClient();
    const npmAdvisoryClient = new OsvNpmAdvisoryClient(osvClient);

    if (requirements.length === 0) {
      console.error('Error: no supported package specs to resolve');
      console.error(JSON.stringify({ unsupported }, null, 2));
      process.exitCode = 1;
      return;
    }

    const registry = new CachedRegistryClient(
      new HttpRegistryClient(options.registry, {
        ...(options.registryTimeoutMs ? { timeoutMs: options.registryTimeoutMs } : {}),
        ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      })
    );
    const stableTagResolutions = await readStableTagResolutionIndex(options.output);
    const metadataCache = await readRegistryMetadataCache(options.output);
    const inspectionCache = options.dryRun
      ? new TarballInspectionCache()
      : await readTarballInspectionCache(options.output);

    if (options.dryRun) {
      const resolution = await fetchSeedBundle({
        advisoryClient: npmAdvisoryClient,
        concurrency: options.concurrency,
        download: false,
        includePeer: options.includePeer === true,
        inspectionCache,
        latestPolicy,
        minReleaseAgeDays: npmSecurity.minReleaseAgeDays,
        outputDir: options.output,
        rangeResolutionPolicy,
        registry,
        metadataCache,
        ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
        stableTagResolutions,
        tagResolutionPolicy,
        ...(options.tarballTimeoutMs ? { tarballTimeoutMs: options.tarballTimeoutMs } : {}),
        gitRequirements,
        requirements,
        unsupported,
        vulnerabilityResolutionPolicy: npmSecurity.vulnerabilityResolutionPolicy,
      });
      console.log(JSON.stringify({ options, ...toFetchDryRun(resolution) }, null, 2));
      if (resolution.errors.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    const resolution = await fetchSeedBundle({
      advisoryClient: npmAdvisoryClient,
      concurrency: options.concurrency,
      includePeer: options.includePeer === true,
      inspectionCache,
      latestPolicy,
      minReleaseAgeDays: npmSecurity.minReleaseAgeDays,
      outputDir: options.output,
      rangeResolutionPolicy,
      registry,
      metadataCache,
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      stableTagResolutions,
      tagResolutionPolicy,
      ...(options.tarballTimeoutMs ? { tarballTimeoutMs: options.tarballTimeoutMs } : {}),
      gitRequirements,
      requirements,
      unsupported,
      vulnerabilityResolutionPolicy: npmSecurity.vulnerabilityResolutionPolicy,
    });
    let success = resolution.errors.length === 0;

    if (success) {
      const documents = createBundleDocuments({
        outputDir: options.output,
        latestPolicy,
        resolved: resolution.resolved,
        sourceRegistry: options.registry,
        tagRequirements: resolution.tagRequirements,
      });
      const security = await scanNpmBundleSecurity({
        advisoryClient: npmAdvisoryClient,
        bundleDir: options.output,
        manifest: documents.manifest,
        inspectionCache,
        policy: {
          ...npmSecurity,
        },
      });
      await writeNpmSecurityReport(options.output, security, { failed: !security.ok });
      success = security.ok;
      if (success) {
        await writeBundleDocuments(options.output, documents);
      }
      await writeFetchReport(
        options.output,
        createFetchReport({
          downloaded: resolution.downloaded,
          downloadedPackages: resolution.downloadedPackages,
          errors: resolution.errors,
          gitRequirements: resolution.gitRequirements,
          resolved: resolution.resolved.length,
          skipped: resolution.skipped,
          timings: resolution.timings,
          unsupported: resolution.unsupported,
          ...(resolution.vulnerabilityResolutions
            ? { vulnerabilityResolutions: resolution.vulnerabilityResolutions }
            : {}),
          warnings: resolution.warnings,
          wouldDownloadPackages: resolution.wouldDownloadPackages,
        })
      );
      if (success) {
        await writeRegistryMetadataCache(options.output, metadataCache, {
          createdAt: new Date().toISOString(),
          sourceRegistry: options.registry,
        });
      }

      for (const warning of resolution.warnings) {
        console.error(
          yellow(
            `[fetch] NPM release-age WARNING [${warning.name}@${warning.version}, required by ${warning.requiredBy}]: ${safeConsoleDetail(warning.reason)}`
          )
        );
      }

      console.log(
        JSON.stringify(
          {
            output: options.output,
            downloaded: resolution.downloaded,
            skipped: resolution.skipped,
            resolved: resolution.resolved.length,
            timings: resolution.timings,
            tagRequirements: resolution.tagRequirements.length,
            warnings: resolution.warnings,
            security,
          },
          null,
          2
        )
      );
    } else {
      console.log(JSON.stringify({ options, unsupported, ...toFetchPreview(resolution) }, null, 2));
    }

    if (inspectionCache.persistentWrites > 0) {
      await writeTarballInspectionCache(options.output, inspectionCache);
    }

    if (!success) {
      process.exitCode = 1;
    }
  });

const npmCommand = program.command('npm').description('Operate on npm packages in a bundle');

addNpmPublishOptions(
  npmCommand
    .command('publish')
    .description('Publish bundle npm packages into an npm-compatible registry')
    .argument('<bundle>', 'Path to airgap bundle directory')
    .requiredOption('-r, --registry <url>', 'Target registry URL')
)
  .option('--registry-type <type>', 'Registry type: verdaccio or gitea; inferred from URL')
  .option(
    '--gitea-token <token>',
    `Gitea package token, defaults to GITEA_TOKEN or ${workspaceSecretsFileName}`
  )
  .option('--dry-run', 'Print planned operations without publishing')
  .action(async (bundle: string, options: PublishOptions) => {
    try {
      const registryType =
        options.registryType ?? (isGiteaNpmRegistryUrl(options.registry) ? 'gitea' : 'verdaccio');
      if (registryType !== 'verdaccio' && registryType !== 'gitea') {
        throw new Error('--registry-type must be verdaccio or gitea');
      }
      const registryAuthToken =
        registryType === 'gitea' && options.dryRun !== true
          ? await requireGiteaToken({
              cliToken: options.giteaToken,
              optionName: '--gitea-token <token>',
              workspaceDir: process.cwd(),
            })
          : undefined;
      const manifest = await readBundleManifest(bundle);
      const distTags = await readDistTagsManifest(bundle);
      const report = await publishBundle(manifest, distTags, {
        bundleDir: bundle,
        distTagConcurrency: options.distTagConcurrency,
        dryRun: options.dryRun === true,
        onProgress: createPublishProgressLogger(),
        publishConcurrency: options.publishConcurrency,
        ...(registryAuthToken ? { registryAuthToken } : {}),
        registryType,
        registryUrl: options.registry,
        skipExisting: options.skipExisting !== false,
      });

      await writePublishReport(bundle, report);
      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('info')
  .description('Show information about an airgap bundle')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .action(async (bundle: string) => {
    try {
      const info = await readBundleInfo(bundle);
      console.log(formatBundleInfo(info));
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const bundleCommand = program.command('bundle').description('Operate on an airgap bundle');

bundleCommand
  .command('prune')
  .description('Remove stale npm, Python, and Git objects not referenced by the latest download')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .option('--dry-run', 'Print stale objects without removing them')
  .option('--json', 'Print the full JSON prune report')
  .action(async (bundle: string, options: BundlePruneOptions) => {
    try {
      const report = await pruneBundle({
        bundleDir: bundle,
        dryRun: options.dryRun === true,
      });
      await writePruneReport(bundle, report);
      console.log(
        options.json === true ? JSON.stringify(report, null, 2) : formatPruneSummary(report)
      );

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const verifyCommand = program.command('verify').description('Verify an airgap bundle');

verifyCommand
  .argument('<bundle>', 'Path to airgap bundle directory')
  .option('--json', 'Print the full JSON verification report')
  .action(async (bundle: string, options: VerifyOptions) => {
    try {
      const report = await verifyBundle({ bundleDir: bundle });
      console.log(
        options.json === true ? JSON.stringify(report, null, 2) : formatVerifyReport(report)
      );

      if (!report.ok) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

verifyCommand
  .command('install')
  .description('Verify real package-manager installs from workspace Git targets')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('-r, --registry <url>', 'Target npm registry URL')
  .requiredOption('--gitea <url>', 'Closed-network Gitea base URL')
  .option(
    '--gitea-token <token>',
    `Gitea package token, defaults to GITEA_TOKEN or ${workspaceSecretsFileName}`
  )
  .option('--timeout-ms <ms>', 'Install timeout per project', parsePositiveInteger, 10 * 60_000)
  .option(
    '--run-scripts',
    'Explicitly allow npm/pnpm/yarn lifecycle scripts during install verification'
  )
  .option('--keep-temp', 'Keep temporary project copies for debugging')
  .option('--json', 'Print the full JSON verification report')
  .action(async (bundle: string, options: VerifyInstallOptions) => {
    try {
      const registryAuthToken = isGiteaNpmRegistryUrl(options.registry)
        ? await resolveGiteaToken({
            cliToken: options.giteaToken,
            workspaceDir: process.cwd(),
          })
        : undefined;
      const report = await verifyInstall({
        bundleDir: bundle,
        giteaBaseUrl: options.gitea,
        ignoreScripts: options.runScripts !== true,
        keepTemp: options.keepTemp === true,
        ...(registryAuthToken ? { registryAuthToken } : {}),
        registryUrl: options.registry,
        timeoutMs: options.timeoutMs,
      });
      console.log(
        options.json === true ? JSON.stringify(report, null, 2) : formatVerifyInstallReport(report)
      );

      if (!report.ok) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const reposCommand = program.command('repos').description('Manage project Git repositories');

reposCommand
  .command('update')
  .description('Update Git repositories under a directory with safe fast-forward pulls')
  .argument('<root>', 'Directory containing Git repositories')
  .option('--dry-run', 'Check repositories without running git pull')
  .action(async (root: string, options: ReposUpdateOptions) => {
    try {
      const report = await updateRepositories({
        dryRun: options.dryRun === true,
        root,
      });

      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const gitCommand = program.command('git').description('Plan and operate Git mirrors');

gitCommand
  .command('sources')
  .description('Create portable Git source metadata from bundle Git requirements')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .option('--write', 'Write git-sources.json into the bundle')
  .action(async (bundle: string, options: GitSourcesOptions) => {
    try {
      const fetchReport = await readFetchReport(bundle);
      const gitRequirements = Array.isArray(fetchReport.gitRequirements)
        ? fetchReport.gitRequirements
        : [];
      const manifest = createGitSourcesManifest(gitRequirements);

      if (options.write === true) {
        await writeGitSourcesManifest(bundle, manifest);
      }

      console.log(JSON.stringify(manifest, null, 2));

      if (manifest.skipped.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

gitCommand
  .command('fetch')
  .description('Clone or update local bare mirrors from Git source metadata')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .option('--mirrors-dir <dir>', 'Directory for bare Git mirrors')
  .option('--concurrency <count>', 'Parallel Git mirror workers', parsePositiveInteger, 8)
  .option('--dry-run', 'Print planned mirror fetch operations without running Git')
  .action(async (bundle: string, options: GitFetchOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const report = await fetchGitSources({
        bundleDir: bundle,
        concurrency: options.concurrency,
        dryRun: options.dryRun === true,
        manifest,
        onProgress: createGitFetchProgressLogger(),
        ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
      });

      await writeGitFetchReport(bundle, report);
      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

gitCommand
  .command('apply')
  .description('Push local bare mirrors into the closed-network Git host')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('--gitea <url>', 'Closed-network Git host base URL')
  .option(
    '--token <token>',
    `Gitea API token for Git push auth, defaults to GITEA_TOKEN or ${workspaceSecretsFileName}`
  )
  .option('--username <name>', 'Git HTTP username for non-Gitea push authentication')
  .option('--password <token>', 'Git HTTP password/token for non-Gitea push authentication')
  .option('--mirrors-dir <dir>', 'Directory containing bare Git mirrors')
  .option('--concurrency <count>', 'Parallel Git push workers', parsePositiveInteger, 2)
  .option('--dry-run', 'Print planned mirror push operations without running Git')
  .action(async (bundle: string, options: GitApplyOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const providedGitAuth = explicitGitAuth({
        password: options.password,
        username: options.username,
      });
      const token = providedGitAuth
        ? undefined
        : await resolveGiteaToken({
            cliToken: options.token,
            workspaceDir: process.cwd(),
          });
      const httpClient =
        options.dryRun === true || !token || providedGitAuth
          ? undefined
          : new HttpGiteaClient(options.gitea, { authToken: token });
      const gitAuth =
        providedGitAuth ??
        (httpClient && token
          ? { password: token, username: await httpClient.currentUserLogin() }
          : undefined);
      const report = await applyGitSources({
        bundleDir: bundle,
        concurrency: options.concurrency,
        dryRun: options.dryRun === true,
        ...(gitAuth ? { gitAuth } : {}),
        giteaBaseUrl: options.gitea,
        manifest,
        onProgress: createGitApplyProgressLogger(),
        ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
      });

      await writeGitApplyReport(bundle, report);
      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

gitCommand
  .command('config')
  .description('Configure Git URL rewrites from git-sources.json')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('--gitea <url>', 'Closed-network Gitea base URL')
  .requiredOption('--global', 'Write rewrite rules into the global Git config')
  .option('--dry-run', 'Print planned Git config operations without writing config')
  .action(async (bundle: string, options: GitConfigOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const report = await configureGitRewrites({
        dryRun: options.dryRun === true,
        giteaBaseUrl: options.gitea,
        manifest,
      });

      await writeGitConfigReport(bundle, report);
      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

gitCommand
  .command('create-repos')
  .description('Create missing Gitea repositories from git-sources.json')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('--gitea <url>', 'Closed-network Gitea base URL')
  .option(
    '--token <token>',
    `Gitea API token, defaults to GITEA_TOKEN or ${workspaceSecretsFileName}`
  )
  .option('--public', 'Create public repositories instead of private repositories')
  .option('--dry-run', 'Print planned repository creation without calling Gitea')
  .action(async (bundle: string, options: GitCreateReposOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const token =
        options.dryRun === true
          ? undefined
          : await requireGiteaToken({
              cliToken: options.token,
              optionName: '--token <token>',
              workspaceDir: process.cwd(),
            });

      const client =
        options.dryRun === true
          ? noopGiteaClient
          : new HttpGiteaClient(options.gitea, { authToken: token ?? '' });
      const report = await provisionGiteaRepositories({
        client,
        dryRun: options.dryRun === true,
        giteaBaseUrl: options.gitea,
        manifest,
        private: options.public !== true,
      });

      await writeGiteaRepositoryProvisionReport(bundle, report);
      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

addNpmPublishOptions(
  program
    .command('publish')
    .description('Publish an airgap bundle to an npm registry and Git host')
    .argument('[bundle]', 'Path to airgap bundle directory; defaults to airgap-sync.json output')
    .option('-r, --registry <url>', 'Target Verdaccio/npm-compatible registry URL')
    .option('--npm-registry-type <type>', 'npm registry type: verdaccio or gitea')
    .option('--npm-owner <owner>', 'Managed Gitea organization for npm packages')
    .option('--gitea <url>', 'Closed-network Git host base URL; defaults to giteaUrl')
    .option('--python-owner <owner>', 'Public Gitea owner for the Python package index')
    .option(
      '--gitea-token <token>',
      `Gitea API token, defaults to GITEA_TOKEN or ${workspaceSecretsFileName}`
    )
    .option('--git-username <name>', 'Git HTTP username for non-Gitea push authentication')
    .option('--git-password <token>', 'Git HTTP password/token for non-Gitea push authentication')
    .option('--git-initial-import <mode>', 'Initial Git repository import: auto or push', 'auto')
    .option(
      '--git-concurrency <count>',
      'Parallel Git import/push workers',
      parsePositiveInteger,
      2
    )
    .option(
      '--git-migration-listen-host <host>',
      'Interface for the temporary authenticated Git migration server',
      '127.0.0.1'
    )
    .option(
      '--git-migration-advertised-host <host>',
      'Host that Gitea uses to reach the temporary Git migration server'
    )
    .option(
      '--git-migration-port <port>',
      'Port for the temporary Git migration server; 0 selects a free port',
      parseNonNegativeInteger,
      0
    )
    .option(
      '--git-owner-strategy <strategy>',
      'Git owner mapping: preserve, authenticated-user, or fixed-owner'
    )
    .option('--git-publish-owner <owner>', 'Destination Gitea owner for fixed-owner mapping')
    .option(
      '--git-publish-owner-kind <kind>',
      'Destination owner kind for fixed-owner mapping: user or organization'
    )
    .option('--mirrors-dir <dir>', 'Directory containing bare Git mirrors')
    .option('--public', 'Create public Gitea repositories instead of private repositories')
    .option(
      '--skip-git-provision',
      'Assume target Git repositories already exist and skip Gitea API provisioning'
    )
)
  .option('--configure-git-global', 'Write Git URL rewrite rules into global Git config')
  .option('--dry-run', 'Print planned publish operations without publishing or pushing')
  .option('--json', 'Print full publish report as JSON')
  .action(async (bundle: string | undefined, options: ApplyOptions) => {
    const startedAt = performance.now();
    try {
      const resolved = await resolvePublishWorkspaceDefaults({
        bundle,
        gitea: options.gitea,
        registry: options.registry,
        ...(options.npmOwner ? { npmOwner: options.npmOwner } : {}),
        ...(options.npmRegistryType ? { npmRegistryType: options.npmRegistryType } : {}),
        ...(options.pythonOwner ? { pythonOwner: options.pythonOwner } : {}),
        ...(options.gitOwnerStrategy ? { gitOwnerStrategy: options.gitOwnerStrategy } : {}),
        ...(options.gitPublishOwner ? { gitPublishOwner: options.gitPublishOwner } : {}),
        ...(options.gitPublishOwnerKind
          ? { gitPublishOwnerKind: options.gitPublishOwnerKind }
          : {}),
      });
      const providedGitAuth = explicitGitAuth({
        password: options.gitPassword,
        username: options.gitUsername,
      });
      if (options.gitInitialImport !== 'auto' && options.gitInitialImport !== 'push') {
        throw new Error('--git-initial-import must be auto or push');
      }
      const publicRepositories =
        options.public === true ? true : resolved.publicRepositories === true;
      const configureGitGlobal =
        options.configureGitGlobal === true || resolved.configureGitGlobal === true;
      const skipGitProvision = options.skipGitProvision === true || resolved.provisionGit === false;
      const needsAuthenticatedGitOwner =
        resolved.gitOwnerStrategy === 'authenticated-user' ||
        (resolved.gitOwnerStrategy === 'fixed-owner' && resolved.gitPublishOwnerKind === 'user');
      const pythonIndex = await readPythonApplicationBundleIndex(resolved.bundle);
      const hasPythonSeed = await fileExists(
        path.join(path.resolve(resolved.bundle), 'python-seed-manifest.json')
      );
      const hasPythonPublication = hasPythonSeed || pythonIndex !== undefined;
      const pythonOwnerTargets = [
        resolved.pythonPublicationProfile.owner,
        resolved.pythonPublicationProfile.pypiOwner,
        resolved.pythonPublicationProfile.genericOwner,
      ].filter((owner) => owner !== undefined);
      const needsAuthenticatedPythonOwner =
        hasPythonPublication &&
        pythonOwnerTargets.some((owner) =>
          owner.strategy === 'authenticated-user' ? true : owner.kind === 'user'
        );
      const needsAuthenticatedNpmOwner =
        resolved.npmRegistryTarget.type === 'gitea' &&
        (resolved.npmRegistryTarget.owner.strategy === 'authenticated-user' ||
          resolved.npmRegistryTarget.owner.kind === 'user');
      const requiresGiteaToken =
        (options.dryRun !== true && hasPythonPublication) ||
        (options.dryRun !== true && resolved.npmRegistryTarget.type === 'gitea') ||
        needsAuthenticatedGitOwner ||
        needsAuthenticatedNpmOwner ||
        needsAuthenticatedPythonOwner;
      const token = requiresGiteaToken
        ? await requireGiteaToken({
            cliToken: options.giteaToken,
            optionName: '--gitea-token <token>',
            workspaceDir: resolved.workspaceDir,
          })
        : options.dryRun === true
          ? undefined
          : skipGitProvision || providedGitAuth
            ? await resolveGiteaToken({
                cliToken: options.giteaToken,
                workspaceDir: resolved.workspaceDir,
              })
            : await requireGiteaToken({
                cliToken: options.giteaToken,
                optionName: '--gitea-token <token>',
                workspaceDir: resolved.workspaceDir,
              });

      const httpClient =
        options.dryRun === true || !token
          ? undefined
          : new HttpGiteaClient(resolved.gitea, { authToken: token });
      const client = httpClient ?? noopGiteaClient;
      const login = httpClient && token ? await httpClient.currentUserLogin() : undefined;
      const gitAuth =
        providedGitAuth ?? (login && token ? { password: token, username: login } : undefined);
      const report = await applyBundle({
        bundleDir: resolved.bundle,
        configureGitGlobal,
        distTagConcurrency: options.distTagConcurrency,
        dryRun: options.dryRun === true,
        ...(gitAuth ? { gitAuth } : {}),
        gitConcurrency: options.gitConcurrency,
        ...(login ? { gitAuthenticatedUser: login } : {}),
        ...(options.gitInitialImport === 'auto' && !skipGitProvision
          ? {
              gitMigration: {
                ...(options.gitMigrationAdvertisedHost
                  ? { advertisedHost: options.gitMigrationAdvertisedHost }
                  : { advertisedHost: 'localhost' }),
                listenHost: options.gitMigrationListenHost ?? '127.0.0.1',
                port: options.gitMigrationPort ?? 0,
              },
            }
          : {}),
        gitOwnerStrategy: resolved.gitOwnerStrategy,
        ...(resolved.gitPublishOwner ? { gitPublishOwner: resolved.gitPublishOwner } : {}),
        ...(resolved.gitPublishOwnerKind
          ? { gitPublishOwnerKind: resolved.gitPublishOwnerKind }
          : {}),
        giteaBaseUrl: resolved.gitea,
        giteaClient: client,
        ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
        npmRegistryTarget: resolved.npmRegistryTarget,
        onPublishProgress: createPublishProgressLogger(),
        onProgress: createApplyProgressLogger(),
        private: !publicRepositories,
        ...(login && token ? { pythonAuth: { password: token, username: login } } : {}),
        ...(resolved.npmRegistryTarget.type === 'gitea' && token
          ? { registryAuthToken: token }
          : {}),
        ...(resolved.pythonOwner ? { pythonOwner: resolved.pythonOwner } : {}),
        pythonPublicationProfile: resolved.pythonPublicationProfile,
        publishConcurrency: options.publishConcurrency,
        skipExisting: options.skipExisting !== false,
        skipGitProvision,
      });
      await writePublishRunHistory({
        bundleDir: path.resolve(resolved.bundle),
        report,
      });

      console.log(
        options.json === true
          ? JSON.stringify(report, null, 2)
          : formatPublishSummary(report, resolved.bundle)
      );

      if (!report.succeeded) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      printTotalElapsedTime(startedAt, options.json === true);
    }
  });

async function main(): Promise<void> {
  if (process.argv.length <= 2) {
    try {
      await runInteractiveMenu('.', {});
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  await program.parseAsync();
}

void main();
