#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';
import { Command } from 'commander';
import {
  addWorkspaceTarget,
  applyBundle,
  applyGitSources,
  CachedRegistryClient,
  clearWorkspaceGiteaToken,
  collectBundle,
  configureGitRewrites,
  createGitSourcesManifest,
  createBundleDocuments,
  createFetchReport,
  createWorkspaceGitSources,
  createWorkspaceSnapshot,
  defaultWorkspaceOutputDir,
  defaultWorkspaceSourceRegistry,
  fetchGitSources,
  fetchSeedBundle,
  HttpGiteaClient,
  HttpRegistryClient,
  initWorkspace,
  packageName,
  packageVersion,
  parseRootSpecs,
  publishBundle,
  readBundleInfo,
  readFetchReport,
  readGitSourcesManifest,
  readManifestRequirements,
  readBundleManifest,
  readDistTagsManifest,
  readWorkspaceConfig,
  readWorkspaceSecrets,
  removeWorkspaceTarget,
  saveWorkspaceGiteaToken,
  updateRepositories,
  verifyBundle,
  verifyInstall,
  writeBundleDocuments,
  writeFetchReport,
  writeGiteaRepositoryProvisionReport,
  writeGitApplyReport,
  writeGitConfigReport,
  writeGitFetchReport,
  writeGitSourcesManifest,
  writePublishReport,
  writeWorkspaceSnapshot,
  writeWorkspaceConfig,
  workspaceSecretsFileName,
  workspaceConfigFileName,
  provisionGiteaRepositories,
} from './index.js';
import type { GiteaClient } from './index.js';
import type {
  ApplyProgressEvent,
  ApplyProgressPhase,
  CollectProgressEvent,
  FetchSeedBundleResult,
  PublishProgressEvent,
  PublishProgressPhase,
  ResolveRootRequirementsResult,
  VerifyReport,
  VerifyInstallReport,
  WorkspaceConfig,
  WorkspacePromptBoolean,
} from './index.js';

const defaultDistTagConcurrency = 4;
const defaultPublishConcurrency = 4;

interface FetchOptions {
  concurrency: number;
  dryRun?: boolean;
  includeDev?: boolean;
  includePeer?: boolean;
  manifest?: string;
  output: string;
  registry: string;
}

interface PublishOptions {
  distTagConcurrency: number;
  dryRun?: boolean;
  publishConcurrency: number;
  registry: string;
  skipExisting?: boolean;
}

interface ApplyOptions {
  configureGitGlobal?: boolean;
  distTagConcurrency: number;
  dryRun?: boolean;
  gitea: string;
  giteaToken?: string;
  mirrorsDir?: string;
  publishConcurrency: number;
  public?: boolean;
  registry: string;
  skipExisting?: boolean;
}

interface VerifyOptions {
  json?: boolean;
}

interface VerifyInstallOptions {
  ignoreScripts?: boolean;
  gitea: string;
  json?: boolean;
  keepTemp?: boolean;
  registry: string;
  timeoutMs: number;
}

interface CollectOptions {
  concurrency: number;
  dryRun?: boolean;
  includeDev?: boolean;
  includePeer?: boolean;
  output?: string;
  registry?: string;
}

interface InitOptions {
  force?: boolean;
}

interface TargetGitOptions {
  branch?: string;
}

interface GitSourcesOptions {
  write?: boolean;
}

interface MenuOptions {
  once?: boolean;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
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
      'Concurrent npm publish operations',
      parsePositiveInteger,
      defaultPublishConcurrency
    );
}

function compactArgs(args: (string | undefined)[]): string[] {
  return args.filter((arg): arg is string => arg !== undefined && arg.length > 0);
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
  repositoryUpdate: { errors: unknown[] };
}): boolean {
  return (
    report.repositoryUpdate.errors.length > 0 ||
    report.fetch.errors.length > 0 ||
    report.gitSources.skipped.length > 0 ||
    report.gitFetch.errors.length > 0 ||
    report.gitManifestScanErrors.length > 0 ||
    report.maxIterationsReached
  );
}

function targetToDisplay(target: { branch?: string; spec?: string; type: string; url?: string }) {
  return target.type === 'git'
    ? {
        branch: target.branch,
        type: target.type,
        url: target.url,
      }
    : {
        spec: target.spec,
        type: target.type,
      };
}

interface GitFetchOptions {
  dryRun?: boolean;
  mirrorsDir?: string;
}

interface GitApplyOptions {
  dryRun?: boolean;
  gitea: string;
  token?: string;
  mirrorsDir?: string;
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
  cleanup: 'cleanup temp tags',
  'dist-tags': 'restore dist-tags',
  'dry-run': 'plan publish',
  'lookup-metadata': 'lookup registry metadata',
  publish: 'publish packages',
  validate: 'validate bundle',
};

const collectPhaseLabels: Record<CollectProgressEvent['phase'], string> = {
  'bundle-write': 'write bundle',
  'git-fetch': 'fetch git mirrors',
  'git-manifest-scan': 'scan git manifests',
  'lockfile-scan': 'scan lockfiles',
  'manifest-scan': 'scan package manifests',
  'npm-fetch': 'resolve/download npm',
  'repository-update': 'update repositories',
};

const applyPhaseLabels: Record<ApplyProgressPhase, string> = {
  gitea: 'provision Gitea repositories',
  'git-apply': 'push Git mirrors',
  'git-config': 'configure Git rewrites',
  publish: 'publish npm packages',
  report: 'write apply report',
};

function createApplyProgressLogger(): (event: ApplyProgressEvent) => void {
  return (event) => {
    const label = applyPhaseLabels[event.phase];
    console.error(`[apply] ${label}: ${event.status === 'start' ? 'started' : 'done'}`);
  };
}

function createCollectProgressLogger(): (event: CollectProgressEvent) => void {
  const lastLogged = new Map<string, number>();

  return (event) => {
    const label = collectPhaseLabels[event.phase];
    const prefix =
      event.iteration === undefined ? '[collect]' : `[collect:${String(event.iteration)}]`;
    const key = `${String(event.iteration ?? 0)}:${event.phase}`;

    if (event.status === 'start') {
      const detail = event.detail ? ` ${event.detail}` : '';
      const total = event.total === undefined ? '' : ` (${String(event.total)})`;
      console.error(`${prefix} ${label}: started${total}${detail}`);
      return;
    }

    if (event.status === 'done') {
      const count =
        event.current === undefined
          ? ''
          : event.total === undefined
            ? ` (${String(event.current)})`
            : ` (${String(event.current)}/${String(event.total)})`;
      console.error(`${prefix} ${label}: done${count}`);
      return;
    }

    if (event.status === 'error') {
      const detail = event.detail ? ` ${event.detail}` : '';
      console.error(`${prefix} ${label}: error${detail}`);
      return;
    }

    if (event.current === undefined) {
      return;
    }

    const last = lastLogged.get(key) ?? 0;
    const threshold =
      event.total && event.total > 0 ? Math.max(1, Math.ceil(event.total / 20)) : 25;
    const shouldLog =
      event.current === 1 ||
      event.current - last >= threshold ||
      (event.total !== undefined && event.current === event.total);

    if (!shouldLog) {
      return;
    }

    lastLogged.set(key, event.current);
    const total = event.total === undefined ? '' : `/${String(event.total)}`;
    const queue = event.queue === undefined ? '' : ` queue=${String(event.queue)}`;
    const detail = event.detail ? ` ${event.detail}` : '';
    console.error(`${prefix} ${label}: ${String(event.current)}${total}${queue}${detail}`);
  };
}

function createPublishProgressLogger(): (event: PublishProgressEvent) => void {
  const lastLogged = new Map<PublishProgressPhase, number>();

  return (event) => {
    const label = publishPhaseLabels[event.phase];

    if (event.status === 'start') {
      const total = event.total === undefined ? '' : ` (${String(event.total)})`;
      console.error(`[publish] ${label}: started${total}`);
      return;
    }

    if (event.status === 'done') {
      const total =
        event.total === undefined
          ? ''
          : ` (${String(event.current ?? event.total)}/${String(event.total)})`;
      console.error(`[publish] ${label}: done${total}`);
      return;
    }

    if (event.status === 'planned') {
      console.error(`[publish] ${label}: ${String(event.current ?? 0)} actions`);
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
      `[publish] ${label}: ${String(event.current)}/${String(event.total)} ${event.status}${subject}`
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
  };
}

function toFetchDryRun(result: FetchSeedBundleResult) {
  return {
    downloaded: result.downloaded,
    gitRequirements: result.gitRequirements,
    skipped: result.skipped,
    wouldDownload: result.wouldDownload,
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

async function giteaTokenFromMenu(workspaceDir: string, rl: ReadlineInterface): Promise<string> {
  const envToken = process.env.GITEA_TOKEN;
  if (envToken) {
    return envToken;
  }

  const savedToken = await readSavedGiteaToken(workspaceDir);
  if (savedToken) {
    console.error(`[menu] apply: using saved Gitea token from ${workspaceSecretsFileName}`);
    return savedToken;
  }

  const token = await ask(rl, 'Gitea token (visible input)');
  if (!token) {
    throw new Error('Gitea token is required for apply');
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
  const targetRegistry = await ask(
    rl,
    'Closed-network npm registry',
    config.targetRegistry ?? 'http://verdaccio.local:4873'
  );
  const giteaUrl = await ask(
    rl,
    'Closed-network Gitea URL',
    config.giteaUrl ?? 'http://gitea.local:3000'
  );
  const nextConfig: WorkspaceConfig = {
    ...config,
    sourceRegistry,
    ...(targetRegistry ? { targetRegistry } : {}),
    ...(giteaUrl ? { giteaUrl } : {}),
  };
  await saveWorkspaceConfig(workspaceDir, nextConfig);
  return nextConfig;
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

async function configureCollectDefaults(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  const includeDev = await askPromptBoolean(
    rl,
    'Include devDependencies by default',
    config.defaults.collect.includeDev
  );
  const includePeer = await askPromptBoolean(
    rl,
    'Traverse peerDependencies by default',
    config.defaults.collect.includePeer
  );
  const nextConfig: WorkspaceConfig = {
    ...config,
    defaults: {
      ...config.defaults,
      collect: {
        includeDev,
        includePeer,
      },
    },
  };
  await saveWorkspaceConfig(workspaceDir, nextConfig);
  return nextConfig;
}

async function configureApplyDefaults(
  workspaceDir: string,
  rl: ReadlineInterface,
  config: WorkspaceConfig
): Promise<WorkspaceConfig> {
  const publicRepositories = await askPromptBoolean(
    rl,
    'Create public Gitea repositories by default',
    config.defaults.apply.publicRepositories
  );
  const configureGitGlobal = await askPromptBoolean(
    rl,
    'Configure global Git rewrites by default',
    config.defaults.apply.configureGitGlobal
  );
  const nextConfig: WorkspaceConfig = {
    ...config,
    defaults: {
      ...config.defaults,
      apply: {
        configureGitGlobal,
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
  return await configureConnectionSettings(workspaceDir, rl, withBundle);
}

async function readMenuWorkspace(workspaceDir: string, rl: ReadlineInterface) {
  try {
    return await readWorkspaceConfig(workspaceDir);
  } catch (error) {
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
  console.log('2. Collect updates');
  console.log('3. Apply bundle');
  console.log('4. Verify bundle');
  console.log('5. Verify installs');
  console.log('6. Show bundle info');
  console.log('7. Settings');
  console.log('0. Exit');
}

async function configureTargetsMenu(workspaceDir: string, rl: ReadlineInterface): Promise<void> {
  console.log('\nTargets');
  console.log('1. Show targets');
  console.log('2. Add Git target');
  console.log('3. Add npm target');
  console.log('4. Remove target');
  console.log('0. Back');

  const choice = await ask(rl, 'Choose an action', '0');
  switch (choice) {
    case '0':
      return;
    case '1':
      await runSelfCommand(['target', 'list', workspaceDir], workspaceDir);
      return;
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
      return;
    }
    case '3': {
      const spec = await ask(rl, 'npm package spec');
      if (spec) {
        await runSelfCommand(['target', 'add', 'npm', spec, workspaceDir], workspaceDir);
      }
      return;
    }
    case '4': {
      await runSelfCommand(['target', 'list', workspaceDir], workspaceDir);
      const index = await ask(rl, 'Target index to remove');
      if (index) {
        await runSelfCommand(['target', 'remove', index, workspaceDir], workspaceDir);
      }
      return;
    }
    default:
      console.log('Unknown menu item.');
  }
}

async function configureWorkspaceMenu(workspaceDir: string, rl: ReadlineInterface): Promise<void> {
  const config = await readMenuWorkspace(workspaceDir, rl);
  console.log('\nSettings');
  console.log('1. Registries and Gitea');
  console.log('2. Bundle directory');
  console.log('3. Collect defaults');
  console.log('4. Apply defaults');
  console.log('5. Verify install defaults');
  console.log('6. Saved credentials');
  console.log('7. Show current config');
  console.log('0. Back');

  const choice = await ask(rl, 'Choose an action', '0');
  switch (choice) {
    case '0':
      return;
    case '1':
      await configureConnectionSettings(workspaceDir, rl, config);
      break;
    case '2':
      await configureBundleDirectory(workspaceDir, rl, config);
      break;
    case '3':
      await configureCollectDefaults(workspaceDir, rl, config);
      break;
    case '4':
      await configureApplyDefaults(workspaceDir, rl, config);
      break;
    case '5':
      await configureVerifyInstallDefaults(workspaceDir, rl, config);
      break;
    case '6':
      await configureCredentialsMenu(workspaceDir, rl);
      return;
    case '7':
      console.log(JSON.stringify(config, null, 2));
      return;
    default:
      console.log('Unknown menu item.');
      return;
  }
  console.log('Saved workspace configuration.');
}

async function targetRegistryFromMenu(
  workspaceDir: string,
  rl: ReadlineInterface
): Promise<string> {
  const config = await readMenuWorkspace(workspaceDir, rl);
  if (config.targetRegistry) {
    return config.targetRegistry;
  }

  const targetRegistry = await ask(
    rl,
    'Closed-network npm registry',
    'http://verdaccio.local:4873'
  );
  if (!targetRegistry) {
    throw new Error('Closed-network npm registry is required');
  }
  await saveWorkspaceConfig(workspaceDir, { ...config, targetRegistry });
  return targetRegistry;
}

async function giteaUrlFromMenu(workspaceDir: string, rl: ReadlineInterface): Promise<string> {
  const config = await readMenuWorkspace(workspaceDir, rl);
  if (config.giteaUrl) {
    return config.giteaUrl;
  }

  const giteaUrl = await ask(rl, 'Closed-network Gitea URL', 'http://gitea.local:3000');
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
      return;
    }
    case '2':
      await clearWorkspaceGiteaToken(workspaceDir);
      console.log(`Cleared Gitea token from ${workspaceSecretsFileName}.`);
      return;
    case '3': {
      const config = await readMenuWorkspace(workspaceDir, rl);
      const giteaUrl = await ask(
        rl,
        'Closed-network Gitea URL',
        config.giteaUrl ?? 'http://gitea.local'
      );
      const token = await giteaTokenFromMenu(workspaceDir, rl);
      const login = await checkGiteaToken(giteaUrl, token);
      console.log(`Gitea token is valid for user: ${login}`);
      return;
    }
    default:
      console.log('Unknown menu item.');
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
        config.defaults.collect.includeDev,
        false
      );
      const includePeer = await resolvePromptBoolean(
        rl,
        'Traverse peerDependencies?',
        config.defaults.collect.includePeer,
        false
      );
      await runSelfCommand(
        compactArgs([
          'collect',
          includeDev ? '--include-dev' : undefined,
          includePeer ? '--include-peer' : undefined,
        ]),
        workspaceDir
      );
      return true;
    }
    case '3': {
      console.error(`[menu] apply: bundle ${bundle}`);
      const targetRegistry = await targetRegistryFromMenu(workspaceDir, rl);
      const giteaUrl = await giteaUrlFromMenu(workspaceDir, rl);
      const publicRepos = await resolvePromptBoolean(
        rl,
        'Create public Gitea repositories?',
        config.defaults.apply.publicRepositories,
        false
      );
      const configureGitGlobal = await resolvePromptBoolean(
        rl,
        'Configure global Git rewrites on this machine?',
        config.defaults.apply.configureGitGlobal,
        false
      );
      console.error(
        `[menu] apply: registry=${targetRegistry} gitea=${giteaUrl} public=${String(
          publicRepos
        )} configureGitGlobal=${String(configureGitGlobal)}`
      );
      const token = await giteaTokenFromMenu(workspaceDir, rl);
      console.error('[menu] apply: Gitea token is set');
      await runSelfCommand(
        compactArgs([
          'apply',
          bundle,
          '--registry',
          targetRegistry,
          '--gitea',
          giteaUrl,
          publicRepos ? '--public' : undefined,
          configureGitGlobal ? '--configure-git-global' : undefined,
        ]),
        workspaceDir,
        token ? { GITEA_TOKEN: token } : {}
      );
      return true;
    }
    case '4':
      await runSelfCommand(['verify', bundle], workspaceDir);
      return true;
    case '5': {
      const targetRegistry = await targetRegistryFromMenu(workspaceDir, rl);
      const giteaUrl = await giteaUrlFromMenu(workspaceDir, rl);
      const ignoreScripts = await resolvePromptBoolean(
        rl,
        'Ignore lifecycle scripts during install verification?',
        config.defaults.verifyInstall.ignoreScripts,
        true
      );
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
        workspaceDir
      );
      return true;
    }
    case '6':
      await runSelfCommand(['info', bundle], workspaceDir);
      return true;
    case '7':
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
  .description('Sync Git and npm dependencies for airgapped environments')
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

const targetCommand = program.command('target').description('Manage workspace sync targets');

targetCommand
  .command('list')
  .description('List targets from airgap-sync.json')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (workspace: string) => {
    try {
      const config = await readWorkspaceConfig(workspace);
      console.log(
        JSON.stringify(
          {
            targets: config.targets.map((target, index) => ({
              index: index + 1,
              ...targetToDisplay(target),
            })),
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

const targetAddCommand = targetCommand.command('add').description('Add a workspace target');

targetAddCommand
  .command('git')
  .description('Add a Git repository target')
  .argument('<url>', 'Git repository URL')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--branch <name>', 'Branch to clone on first materialization')
  .action(async (url: string, workspace: string, options: TargetGitOptions) => {
    try {
      const result = await addWorkspaceTarget(workspace, {
        ...(options.branch ? { branch: options.branch } : {}),
        type: 'git',
        url,
      });
      console.log(
        JSON.stringify(
          {
            added: result.added,
            target: targetToDisplay({
              ...(options.branch ? { branch: options.branch } : {}),
              type: 'git',
              url,
            }),
            totalTargets: result.config.targets.length,
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
        JSON.stringify(
          {
            added: result.added,
            target: targetToDisplay({ spec, type: 'npm' }),
            totalTargets: result.config.targets.length,
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
  .command('remove')
  .description('Remove a target by its one-based list index')
  .argument('<index>', 'Target index from target list')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (index: string, workspace: string) => {
    try {
      const result = await removeWorkspaceTarget(workspace, parsePositiveInteger(index));
      console.log(
        JSON.stringify(
          {
            removed: targetToDisplay(result.removed),
            totalTargets: result.config.targets.length,
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
  .command('collect')
  .description('Update repositories and build an online airgap bundle')
  .argument('[root]', 'Directory containing project Git repositories or package manifests')
  .option('-o, --output <dir>', 'Bundle output directory')
  .option('-r, --registry <url>', 'Source registry URL')
  .option('--include-dev', 'Include root devDependencies')
  .option('--include-peer', 'Traverse peerDependencies')
  .option(
    '--concurrency <count>',
    'Parallel npm resolve/download workers',
    parsePositiveInteger,
    16
  )
  .option('--dry-run', 'Resolve and report without pulling, downloading, or cloning')
  .action(async (root: string | undefined, options: CollectOptions) => {
    try {
      if (!root) {
        const workspaceDir = process.cwd();
        const config = await readWorkspaceConfig(workspaceDir);
        const parsedTargets = parseRootSpecs(
          config.targets.filter((target) => target.type === 'npm').map((target) => target.spec)
        );
        const gitTargets = createWorkspaceGitSources(config);
        const registryUrl = options.registry ?? config.sourceRegistry;
        const outputDir = path.resolve(workspaceDir, options.output ?? config.output);
        const snapshotOutput = options.output
          ? path.relative(workspaceDir, outputDir) || '.'
          : config.output;
        const registry = new CachedRegistryClient(new HttpRegistryClient(registryUrl));
        const report = await collectBundle({
          dryRun: options.dryRun === true,
          concurrency: options.concurrency,
          includeDev: options.includeDev === true,
          includePeer: options.includePeer === true,
          initialGitRequirements: parsedTargets.gitRequirements,
          initialGitSources: gitTargets,
          initialRequirements: parsedTargets.requirements,
          initialUnsupported: parsedTargets.unsupported,
          onProgress: createCollectProgressLogger(),
          outputDir,
          registry,
          registryUrl,
        });
        const workspaceSnapshot = createWorkspaceSnapshot({
          config: {
            ...config,
            output: snapshotOutput,
            sourceRegistry: registryUrl,
          },
          createdAt: report.generatedAt,
        });
        if (options.dryRun !== true) {
          await writeWorkspaceSnapshot(outputDir, workspaceSnapshot);
        }

        console.log(
          JSON.stringify(
            {
              workspaceSnapshot,
              ...report,
            },
            null,
            2
          )
        );

        if (collectShouldFail(report)) {
          process.exitCode = 1;
        }
        return;
      }

      const registryUrl = options.registry ?? defaultWorkspaceSourceRegistry;
      const outputDir = options.output ?? './airgap-bundle';
      const registry = new CachedRegistryClient(new HttpRegistryClient(registryUrl));
      const report = await collectBundle({
        dryRun: options.dryRun === true,
        concurrency: options.concurrency,
        includeDev: options.includeDev === true,
        includePeer: options.includePeer === true,
        onProgress: createCollectProgressLogger(),
        outputDir,
        registry,
        registryUrl,
        root,
      });

      console.log(JSON.stringify(report, null, 2));

      if (collectShouldFail(report)) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
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
    '--concurrency <count>',
    'Parallel npm resolve/download workers',
    parsePositiveInteger,
    16
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

    if (requirements.length === 0) {
      console.error('Error: no supported package specs to resolve');
      console.error(JSON.stringify({ unsupported }, null, 2));
      process.exitCode = 1;
      return;
    }

    const registry = new CachedRegistryClient(new HttpRegistryClient(options.registry));

    if (options.dryRun) {
      const resolution = await fetchSeedBundle({
        concurrency: options.concurrency,
        download: false,
        includePeer: options.includePeer === true,
        outputDir: options.output,
        registry,
        gitRequirements,
        requirements,
        unsupported,
      });
      console.log(JSON.stringify({ options, ...toFetchDryRun(resolution) }, null, 2));
      if (resolution.errors.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    const resolution = await fetchSeedBundle({
      concurrency: options.concurrency,
      includePeer: options.includePeer === true,
      outputDir: options.output,
      registry,
      gitRequirements,
      requirements,
      unsupported,
    });
    const success = resolution.errors.length === 0;

    if (success) {
      const documents = createBundleDocuments({
        outputDir: options.output,
        resolved: resolution.resolved,
        sourceRegistry: options.registry,
        tagRequirements: resolution.tagRequirements,
      });
      await writeBundleDocuments(options.output, documents);
      await writeFetchReport(
        options.output,
        createFetchReport({
          downloaded: resolution.downloaded,
          errors: resolution.errors,
          gitRequirements: resolution.gitRequirements,
          resolved: resolution.resolved.length,
          skipped: resolution.skipped,
          timings: resolution.timings,
          unsupported: resolution.unsupported,
        })
      );

      console.log(
        JSON.stringify(
          {
            output: options.output,
            downloaded: resolution.downloaded,
            skipped: resolution.skipped,
            resolved: resolution.resolved.length,
            timings: resolution.timings,
            tagRequirements: resolution.tagRequirements.length,
          },
          null,
          2
        )
      );
    } else {
      console.log(JSON.stringify({ options, unsupported, ...toFetchPreview(resolution) }, null, 2));
    }

    if (!success) {
      process.exitCode = 1;
    }
  });

addNpmPublishOptions(
  program
    .command('publish')
    .description('Publish an airgap bundle into an npm-compatible registry')
    .argument('<bundle>', 'Path to airgap bundle directory')
    .requiredOption('-r, --registry <url>', 'Target registry URL')
)
  .option('--dry-run', 'Print planned operations without publishing')
  .action(async (bundle: string, options: PublishOptions) => {
    try {
      const manifest = await readBundleManifest(bundle);
      const distTags = await readDistTagsManifest(bundle);
      const report = await publishBundle(manifest, distTags, {
        bundleDir: bundle,
        distTagConcurrency: options.distTagConcurrency,
        dryRun: options.dryRun === true,
        onProgress: createPublishProgressLogger(),
        publishConcurrency: options.publishConcurrency,
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
      console.log(JSON.stringify(info, null, 2));
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
  .option('--timeout-ms <ms>', 'Install timeout per project', parsePositiveInteger, 10 * 60_000)
  .option('--ignore-scripts', 'Skip npm/pnpm/yarn lifecycle scripts during install verification')
  .option('--keep-temp', 'Keep temporary project copies for debugging')
  .option('--json', 'Print the full JSON verification report')
  .action(async (bundle: string, options: VerifyInstallOptions) => {
    try {
      const report = await verifyInstall({
        bundleDir: bundle,
        giteaBaseUrl: options.gitea,
        ignoreScripts: options.ignoreScripts === true,
        keepTemp: options.keepTemp === true,
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
  .option('--dry-run', 'Print planned mirror fetch operations without running Git')
  .action(async (bundle: string, options: GitFetchOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const report = await fetchGitSources({
        bundleDir: bundle,
        dryRun: options.dryRun === true,
        manifest,
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
  .description('Push local bare mirrors into Gitea and report Git rewrite rules')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('--gitea <url>', 'Closed-network Gitea base URL')
  .option(
    '--token <token>',
    `Gitea API token for Git push auth, defaults to GITEA_TOKEN or ${workspaceSecretsFileName}`
  )
  .option('--mirrors-dir <dir>', 'Directory containing bare Git mirrors')
  .option('--dry-run', 'Print planned mirror push operations without running Git')
  .action(async (bundle: string, options: GitApplyOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const token = await resolveGiteaToken({
        cliToken: options.token,
        workspaceDir: process.cwd(),
      });
      const httpClient =
        options.dryRun === true || !token
          ? undefined
          : new HttpGiteaClient(options.gitea, { authToken: token });
      const gitAuth = httpClient
        ? { password: token ?? '', username: await httpClient.currentUserLogin() }
        : undefined;
      const report = await applyGitSources({
        bundleDir: bundle,
        dryRun: options.dryRun === true,
        ...(gitAuth ? { gitAuth } : {}),
        giteaBaseUrl: options.gitea,
        manifest,
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
    .command('apply')
    .description('Apply an airgap bundle to Verdaccio and Gitea')
    .argument('<bundle>', 'Path to airgap bundle directory')
    .requiredOption('-r, --registry <url>', 'Target npm registry URL')
    .requiredOption('--gitea <url>', 'Closed-network Gitea base URL')
    .option(
      '--gitea-token <token>',
      `Gitea API token, defaults to GITEA_TOKEN or ${workspaceSecretsFileName}`
    )
    .option('--mirrors-dir <dir>', 'Directory containing bare Git mirrors')
    .option('--public', 'Create public Gitea repositories instead of private repositories')
)
  .option('--configure-git-global', 'Write Git URL rewrite rules into global Git config')
  .option('--dry-run', 'Print planned apply operations without publishing or pushing')
  .action(async (bundle: string, options: ApplyOptions) => {
    try {
      const token =
        options.dryRun === true
          ? undefined
          : await requireGiteaToken({
              cliToken: options.giteaToken,
              optionName: '--gitea-token <token>',
              workspaceDir: process.cwd(),
            });

      const httpClient =
        options.dryRun === true
          ? undefined
          : new HttpGiteaClient(options.gitea, { authToken: token ?? '' });
      const client = httpClient ?? noopGiteaClient;
      const gitAuth = httpClient
        ? { password: token ?? '', username: await httpClient.currentUserLogin() }
        : undefined;
      const report = await applyBundle({
        bundleDir: bundle,
        configureGitGlobal: options.configureGitGlobal === true,
        distTagConcurrency: options.distTagConcurrency,
        dryRun: options.dryRun === true,
        ...(gitAuth ? { gitAuth } : {}),
        giteaBaseUrl: options.gitea,
        giteaClient: client,
        ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
        onPublishProgress: createPublishProgressLogger(),
        onProgress: createApplyProgressLogger(),
        private: options.public !== true,
        publishConcurrency: options.publishConcurrency,
        registryUrl: options.registry,
        skipExisting: options.skipExisting !== false,
      });

      console.log(JSON.stringify(report, null, 2));

      if (!report.succeeded) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
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
