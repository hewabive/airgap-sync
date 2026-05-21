import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as fs from './fs.js';
import { writeVerifyInstallReport } from './bundle.js';
import { createGitConfigRewriteRules } from './git-apply.js';
import { normalizeBaseUrl } from './git-targets.js';
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

function workspaceRootFromBundle(bundleDir: string, snapshot: WorkspaceSnapshot): string {
  if (path.isAbsolute(snapshot.output)) {
    return path.dirname(path.resolve(snapshot.output));
  }

  const depth = snapshot.output
    .split(/[\\/]/u)
    .filter((segment) => segment.length > 0 && segment !== '.').length;
  return path.resolve(bundleDir, ...Array.from({ length: depth }, () => '..'));
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

async function detectInstallCommand(projectPath: string): Promise<InstallCommand | undefined> {
  if (await fs.pathExists(path.join(projectPath, 'pnpm-lock.yaml'))) {
    return {
      args: ['install', '--frozen-lockfile'],
      command: 'pnpm',
      packageManager: 'pnpm',
    };
  }

  if (await fs.pathExists(path.join(projectPath, 'package-lock.json'))) {
    return {
      args: ['ci'],
      command: 'npm',
      packageManager: 'npm',
    };
  }

  if (await fs.pathExists(path.join(projectPath, 'yarn.lock'))) {
    return {
      args: ['install', '--immutable'],
      command: 'yarn',
      packageManager: 'yarn',
    };
  }

  return undefined;
}

async function copyProject(sourcePath: string, targetPath: string): Promise<void> {
  await fs.cp(sourcePath, targetPath, {
    filter(source) {
      const relative = path.relative(sourcePath, source);
      return !relative.split(path.sep).includes('node_modules');
    },
    recursive: true,
  });
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

function installEnv(options: { gitConfigPath: string; registryUrl: string }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: options.gitConfigPath,
    npm_config_registry: options.registryUrl,
    NPM_CONFIG_REGISTRY: options.registryUrl,
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
  env: NodeJS.ProcessEnv;
  projectPath: string;
  runner: InstallCommandRunner;
  targetUrl: string;
  tempRoot: string;
  timeoutMs: number;
}): Promise<VerifyInstallProjectResult> {
  if (!(await fs.pathExists(options.projectPath))) {
    return {
      projectPath: options.projectPath,
      reason: 'Project path does not exist',
      status: 'skipped',
      targetUrl: options.targetUrl,
    };
  }

  const command = await detectInstallCommand(options.projectPath);
  if (!command) {
    return {
      projectPath: options.projectPath,
      reason: 'No supported lockfile found',
      status: 'skipped',
      targetUrl: options.targetUrl,
    };
  }

  const tempPath = path.join(options.tempRoot, path.basename(options.projectPath));
  await copyProject(options.projectPath, tempPath);
  const result = await options.runner({
    args: command.args,
    command: command.command,
    cwd: tempPath,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  return {
    command: [command.command, ...command.args],
    exitCode: result.exitCode,
    packageManager: command.packageManager,
    projectPath: options.projectPath,
    status: result.exitCode === 0 ? 'passed' : 'failed',
    stderr: truncateOutput(result.stderr),
    stdout: truncateOutput(result.stdout),
    targetUrl: options.targetUrl,
    tempPath,
  };
}

export async function verifyInstall(options: VerifyInstallOptions): Promise<VerifyInstallReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? defaultInstallTimeoutMs;
  const snapshot = await readWorkspaceSnapshot(bundleDir);
  const gitSources = await readOptionalGitSources(bundleDir);
  const workspaceRoot = workspaceRootFromBundle(bundleDir, snapshot);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-install-'));
  const gitConfigPath = path.join(tempRoot, 'gitconfig');
  await fs.writeFile(gitConfigPath, gitConfigContent(gitSources, options.giteaBaseUrl));

  const env = installEnv({
    gitConfigPath,
    registryUrl: options.registryUrl,
  });
  const runner = options.runner ?? runInstallCommand;

  let projects: VerifyInstallProjectResult[];
  try {
    projects = [];
    for (const target of gitTargets(snapshot)) {
      projects.push(
        await verifyProjectInstall({
          env,
          projectPath: path.resolve(workspaceRoot, target.localPath),
          runner,
          targetUrl: target.url,
          tempRoot,
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
    projects,
    registryUrl: options.registryUrl,
    ...summary,
  };

  if (options.writeReport !== false) {
    await writeVerifyInstallReport(bundleDir, report);
  }

  return report;
}
