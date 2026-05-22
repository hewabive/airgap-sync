import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as fs from './fs.js';
import { writeVerifyInstallReport } from './bundle.js';
import { createGitConfigRewriteRules } from './git-apply.js';
import { normalizeBaseUrl } from './git-targets.js';
import { runGitCommand, type GitCommandRunner } from './git-fetch.js';
import type {
  GitSourcesManifest,
  VerifyInstallPackageManager,
  VerifyInstallProjectResult,
  VerifyInstallReport,
} from '../types.js';
import type { WorkspaceSnapshot, WorkspaceTargetSnapshot } from './workspace.js';

export interface InstallCommandInvocation {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface InstallCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type InstallCommandRunner = (
  invocation: InstallCommandInvocation
) => Promise<InstallCommandResult>;

export interface VerifyInstallOptions {
  bundleDir: string;
  generatedAt?: string;
  giteaBaseUrl: string;
  gitRunner?: GitCommandRunner;
  ignoreScripts?: boolean;
  keepTemp?: boolean;
  registryUrl: string;
  runner?: InstallCommandRunner;
  timeoutMs?: number;
  writeReport?: boolean;
}

interface InstallCommand {
  args: string[];
  command: string;
  packageManager: VerifyInstallPackageManager;
}

const defaultInstallTimeoutMs = 10 * 60_000;
const maxCapturedOutputLength = 8000;

function truncateOutput(value: string): string {
  return value.length <= maxCapturedOutputLength ? value : value.slice(-maxCapturedOutputLength);
}

export async function runInstallCommand(
  invocation: InstallCommandInvocation
): Promise<InstallCommandResult> {
  return await new Promise<InstallCommandResult>((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, invocation.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({
        exitCode: 127,
        stderr: error.message,
        stdout: '',
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stderr: signal ? `terminated by ${signal}` : Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
}

function gitTargets(snapshot: WorkspaceSnapshot): (WorkspaceTargetSnapshot & { type: 'git' })[] {
  return snapshot.targets.filter(
    (target): target is WorkspaceTargetSnapshot & { type: 'git' } => target.type === 'git'
  );
}

async function readWorkspaceSnapshot(bundleDir: string): Promise<WorkspaceSnapshot> {
  return fs.readJson<WorkspaceSnapshot>(path.join(bundleDir, 'workspace-snapshot.json'));
}

async function readOptionalGitSources(bundleDir: string): Promise<GitSourcesManifest | undefined> {
  const filePath = path.join(bundleDir, 'git-sources.json');
  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }

  return fs.readJson<GitSourcesManifest>(filePath);
}

async function detectInstallCommand(
  projectPath: string,
  options: { ignoreScripts?: boolean } = {}
): Promise<InstallCommand | undefined> {
  if (await fs.pathExists(path.join(projectPath, 'pnpm-lock.yaml'))) {
    return {
      args: [
        'install',
        '--frozen-lockfile',
        ...(options.ignoreScripts === true ? ['--ignore-scripts'] : []),
      ],
      command: 'pnpm',
      packageManager: 'pnpm',
    };
  }

  if (await fs.pathExists(path.join(projectPath, 'package-lock.json'))) {
    return {
      args: ['ci', ...(options.ignoreScripts === true ? ['--ignore-scripts'] : [])],
      command: 'npm',
      packageManager: 'npm',
    };
  }

  if (await fs.pathExists(path.join(projectPath, 'yarn.lock'))) {
    return {
      args: [
        'install',
        '--immutable',
        ...(options.ignoreScripts === true ? ['--mode=skip-builds'] : []),
      ],
      command: 'yarn',
      packageManager: 'yarn',
    };
  }

  return undefined;
}

function gitConfigContent(
  gitSources: GitSourcesManifest | undefined,
  giteaBaseUrl: string
): string {
  const rules =
    gitSources && gitSources.sources.length > 0
      ? createGitConfigRewriteRules(gitSources, giteaBaseUrl)
      : [
          {
            insteadOf: 'https://github.com/',
            targetUrl: `${normalizeBaseUrl(giteaBaseUrl)}/`,
          },
        ];

  return rules
    .map((rule) => [`[url "${rule.targetUrl}"]`, `\tinsteadOf = ${rule.insteadOf}`, ''].join('\n'))
    .join('\n');
}

function installEnv(options: {
  cacheRoot: string;
  gitConfigPath: string;
  registryUrl: string;
}): NodeJS.ProcessEnv {
  const npmCache = path.join(options.cacheRoot, 'npm');
  const pnpmStore = path.join(options.cacheRoot, 'pnpm-store');
  const yarnCache = path.join(options.cacheRoot, 'yarn');

  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: options.gitConfigPath,
    npm_config_cache: npmCache,
    npm_config_replace_registry_host: 'npmjs',
    npm_config_registry: options.registryUrl,
    npm_config_store_dir: pnpmStore,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_REPLACE_REGISTRY_HOST: 'npmjs',
    NPM_CONFIG_REGISTRY: options.registryUrl,
    NPM_CONFIG_STORE_DIR: pnpmStore,
    YARN_CACHE_FOLDER: yarnCache,
  };
}

function summarize(
  projects: VerifyInstallProjectResult[]
): Pick<VerifyInstallReport, 'failed' | 'ok' | 'passed' | 'skipped' | 'totalProjects'> {
  const failed = projects.filter((project) => project.status === 'failed').length;
  return {
    failed,
    ok: failed === 0,
    passed: projects.filter((project) => project.status === 'passed').length,
    skipped: projects.filter((project) => project.status === 'skipped').length,
    totalProjects: projects.length,
  };
}

async function verifyProjectInstall(options: {
  checkoutPath: string;
  env: NodeJS.ProcessEnv;
  ignoreScripts?: boolean;
  runner: InstallCommandRunner;
  sourceId: string;
  targetUrl: string;
  timeoutMs: number;
}): Promise<VerifyInstallProjectResult> {
  if (!(await fs.pathExists(options.checkoutPath))) {
    return {
      projectPath: options.sourceId,
      reason: 'Project path does not exist',
      status: 'skipped',
      targetUrl: options.targetUrl,
    };
  }

  const command = await detectInstallCommand(options.checkoutPath, {
    ignoreScripts: options.ignoreScripts === true,
  });
  if (!command) {
    return {
      projectPath: options.sourceId,
      reason: 'No supported lockfile found',
      status: 'skipped',
      targetUrl: options.targetUrl,
    };
  }

  const result = await options.runner({
    args: command.args,
    command: command.command,
    cwd: options.checkoutPath,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  return {
    command: [command.command, ...command.args],
    exitCode: result.exitCode,
    packageManager: command.packageManager,
    projectPath: options.sourceId,
    status: result.exitCode === 0 ? 'passed' : 'failed',
    stderr: truncateOutput(result.stderr),
    stdout: truncateOutput(result.stdout),
    targetUrl: options.targetUrl,
    tempPath: options.checkoutPath,
  };
}

async function checkoutTarget(options: {
  bundleDir: string;
  gitRunner: GitCommandRunner;
  target: WorkspaceTargetSnapshot & { type: 'git' };
  tempRoot: string;
}): Promise<{ checkoutPath: string; mirrorPath: string; skippedReason?: string }> {
  const mirrorPath = path.resolve(options.bundleDir, options.target.localMirrorPath);
  const checkoutPath = path.join(
    options.tempRoot,
    'projects',
    ...options.target.sourceId.split('/')
  );

  if (!(await fs.pathExists(mirrorPath))) {
    return {
      checkoutPath,
      mirrorPath,
      skippedReason: 'Local Git mirror does not exist',
    };
  }

  await fs.ensureDir(path.dirname(checkoutPath));
  await options.gitRunner({
    args: [
      'clone',
      ...(options.target.branch ? ['--branch', options.target.branch] : []),
      mirrorPath,
      checkoutPath,
    ],
  });

  return { checkoutPath, mirrorPath };
}

export async function verifyInstall(options: VerifyInstallOptions): Promise<VerifyInstallReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? defaultInstallTimeoutMs;
  const snapshot = await readWorkspaceSnapshot(bundleDir);
  const gitSources = await readOptionalGitSources(bundleDir);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-install-'));
  const gitConfigPath = path.join(tempRoot, 'gitconfig');
  await fs.writeFile(gitConfigPath, gitConfigContent(gitSources, options.giteaBaseUrl));

  const env = installEnv({
    cacheRoot: path.join(tempRoot, 'cache'),
    gitConfigPath,
    registryUrl: options.registryUrl,
  });
  const runner = options.runner ?? runInstallCommand;
  const gitRunner = options.gitRunner ?? runGitCommand;

  let projects: VerifyInstallProjectResult[];
  try {
    projects = [];
    for (const target of gitTargets(snapshot)) {
      const checkout = await checkoutTarget({
        bundleDir,
        gitRunner,
        target,
        tempRoot,
      });
      if (checkout.skippedReason) {
        projects.push({
          projectPath: target.sourceId,
          reason: checkout.skippedReason,
          status: 'skipped',
          targetUrl: target.url,
        });
        continue;
      }

      projects.push(
        await verifyProjectInstall({
          checkoutPath: checkout.checkoutPath,
          env,
          ignoreScripts: options.ignoreScripts === true,
          runner,
          sourceId: target.sourceId,
          targetUrl: target.url,
          timeoutMs,
        })
      );
    }
  } finally {
    if (options.keepTemp !== true) {
      await fs.remove(tempRoot);
    }
  }

  const summary = summarize(projects);
  const report: VerifyInstallReport = {
    bundle: bundleDir,
    generatedAt,
    giteaBaseUrl: options.giteaBaseUrl,
    ignoreScripts: options.ignoreScripts === true,
    projects,
    registryUrl: options.registryUrl,
    ...summary,
  };

  if (options.writeReport !== false) {
    await writeVerifyInstallReport(bundleDir, report);
  }

  return report;
}
