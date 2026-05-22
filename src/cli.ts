#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';
import { Command } from 'commander';
import {
  addWorkspaceTarget,
  applyBundle,
  applyGitSources,
  CachedRegistryClient,
  collectBundle,
  configureGitRewrites,
  createGitSourcesManifest,
  createBundleDocuments,
  createFetchReport,
  createWorkspaceGitSources,
  createWorkspaceSnapshot,
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
  removeWorkspaceTarget,
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
  mirrorsDir?: string;
}

interface GitConfigOptions {
  dryRun?: boolean;
  gitea: string;
  global?: boolean;
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

async function askSecret(rl: ReadlineInterface, question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return ask(rl, question);
  }

  rl.pause();
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdout.write(`${question}: `);

  return await new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw);
      rl.resume();
    };

    const onKeypress = (chunk: string, key: { ctrl?: boolean; name?: string }) => {
      if (key.ctrl === true && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        reject(new Error('Interrupted'));
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        process.stdout.write('\n');
        resolve(value.trim());
        return;
      }

      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }

      if (chunk && chunk >= ' ') {
        value += chunk;
      }
    };

    process.stdin.on('keypress', onKeypress);
  });
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

async function readMenuWorkspace(workspaceDir: string, rl: ReadlineInterface) {
  try {
    return await readWorkspaceConfig(workspaceDir);
  } catch (error) {
    if (
      !(await askYesNo(rl, `${workspaceConfigFileName} not found. Initialize workspace?`, true))
    ) {
      throw error;
    }
    return initWorkspace({ workspaceDir });
  }
}

function printMenu(): void {
  console.log('\nairgap-sync');
  console.log('1. Show targets');
  console.log('2. Add Git target');
  console.log('3. Add npm target');
  console.log('4. Remove target');
  console.log('5. Configure registries and Gitea');
  console.log('6. Collect updates');
  console.log('7. Verify bundle');
  console.log('8. Apply bundle');
  console.log('9. Verify installs');
  console.log('10. Show bundle info');
  console.log('0. Exit');
}

async function configureWorkspaceMenu(workspaceDir: string, rl: ReadlineInterface): Promise<void> {
  const config = await readMenuWorkspace(workspaceDir, rl);
  const sourceRegistry = await ask(rl, 'Source npm registry', config.sourceRegistry);
  const targetRegistry = await ask(
    rl,
    'Closed-network npm registry',
    config.targetRegistry ?? 'http://verdaccio.local:4873'
  );
  const giteaUrl = await ask(
    rl,
    'Closed-network Gitea URL',
    config.giteaUrl ?? 'http://gitea.local'
  );

  await writeWorkspaceConfig(workspaceDir, {
    ...config,
    sourceRegistry,
    ...(targetRegistry ? { targetRegistry } : {}),
    ...(giteaUrl ? { giteaUrl } : {}),
  });
  console.log('Saved workspace configuration.');
}

async function targetRegistryFromMenu(
  workspaceDir: string,
  rl: ReadlineInterface
): Promise<string> {
  const config = await readMenuWorkspace(workspaceDir, rl);
  const targetRegistry = await ask(
    rl,
    'Closed-network npm registry',
    config.targetRegistry ?? 'http://verdaccio.local:4873'
  );
  if (!targetRegistry) {
    throw new Error('Closed-network npm registry is required');
  }
  if (targetRegistry !== config.targetRegistry) {
    await writeWorkspaceConfig(workspaceDir, { ...config, targetRegistry });
  }
  return targetRegistry;
}

async function giteaUrlFromMenu(workspaceDir: string, rl: ReadlineInterface): Promise<string> {
  const config = await readMenuWorkspace(workspaceDir, rl);
  const giteaUrl = await ask(
    rl,
    'Closed-network Gitea URL',
    config.giteaUrl ?? 'http://gitea.local'
  );
  if (!giteaUrl) {
    throw new Error('Closed-network Gitea URL is required');
  }
  if (giteaUrl !== config.giteaUrl) {
    await writeWorkspaceConfig(workspaceDir, { ...config, giteaUrl });
  }
  return giteaUrl;
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
      await runSelfCommand(['target', 'list', workspaceDir], workspaceDir);
      return true;
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
      return true;
    }
    case '3': {
      const spec = await ask(rl, 'npm package spec');
      if (spec) {
        await runSelfCommand(['target', 'add', 'npm', spec, workspaceDir], workspaceDir);
      }
      return true;
    }
    case '4': {
      await runSelfCommand(['target', 'list', workspaceDir], workspaceDir);
      const index = await ask(rl, 'Target index to remove');
      if (index) {
        await runSelfCommand(['target', 'remove', index, workspaceDir], workspaceDir);
      }
      return true;
    }
    case '5':
      await configureWorkspaceMenu(workspaceDir, rl);
      return true;
    case '6': {
      const includeDev = await askYesNo(rl, 'Include devDependencies?', false);
      const includePeer = await askYesNo(rl, 'Traverse peerDependencies?', false);
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
    case '7':
      await runSelfCommand(['verify', bundle], workspaceDir);
      return true;
    case '8': {
      const targetRegistry = await targetRegistryFromMenu(workspaceDir, rl);
      const giteaUrl = await giteaUrlFromMenu(workspaceDir, rl);
      const publicRepos = await askYesNo(rl, 'Create public Gitea repositories?', false);
      const configureGitGlobal = await askYesNo(
        rl,
        'Configure global Git rewrites on this machine?',
        false
      );
      const token = process.env.GITEA_TOKEN ?? (await askSecret(rl, 'Gitea token'));
      if (!token) {
        throw new Error('Gitea token is required for apply; set GITEA_TOKEN or enter a token');
      }
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
    case '9': {
      const targetRegistry = await targetRegistryFromMenu(workspaceDir, rl);
      const giteaUrl = await giteaUrlFromMenu(workspaceDir, rl);
      const ignoreScripts = await askYesNo(
        rl,
        'Ignore lifecycle scripts during install verification?',
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
    case '10':
      await runSelfCommand(['info', bundle], workspaceDir);
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
  .option('--mirrors-dir <dir>', 'Directory containing bare Git mirrors')
  .option('--dry-run', 'Print planned mirror push operations without running Git')
  .action(async (bundle: string, options: GitApplyOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const report = await applyGitSources({
        bundleDir: bundle,
        dryRun: options.dryRun === true,
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
  .option('--token <token>', 'Gitea API token, defaults to GITEA_TOKEN')
  .option('--public', 'Create public repositories instead of private repositories')
  .option('--dry-run', 'Print planned repository creation without calling Gitea')
  .action(async (bundle: string, options: GitCreateReposOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const token = options.token ?? process.env.GITEA_TOKEN;
      if (!token && options.dryRun !== true) {
        console.error('Error: provide --token <token> or set GITEA_TOKEN');
        process.exitCode = 1;
        return;
      }

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
    .option('--gitea-token <token>', 'Gitea API token, defaults to GITEA_TOKEN')
    .option('--mirrors-dir <dir>', 'Directory containing bare Git mirrors')
    .option('--public', 'Create public Gitea repositories instead of private repositories')
)
  .option('--configure-git-global', 'Write Git URL rewrite rules into global Git config')
  .option('--dry-run', 'Print planned apply operations without publishing or pushing')
  .action(async (bundle: string, options: ApplyOptions) => {
    try {
      const token = options.giteaToken ?? process.env.GITEA_TOKEN;
      if (!token && options.dryRun !== true) {
        console.error('Error: provide --gitea-token <token> or set GITEA_TOKEN');
        process.exitCode = 1;
        return;
      }

      const client =
        options.dryRun === true
          ? noopGiteaClient
          : new HttpGiteaClient(options.gitea, { authToken: token ?? '' });
      const report = await applyBundle({
        bundleDir: bundle,
        configureGitGlobal: options.configureGitGlobal === true,
        distTagConcurrency: options.distTagConcurrency,
        dryRun: options.dryRun === true,
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
