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
import { readPythonSeedManifest, type PythonSeedManifest } from './python/bundle.js';
import type { PythonTargetEnvironmentConfig } from './python/environments.js';
import {
  readPythonApplicationBundleIndex,
  type PythonApplicationBundleEntry,
} from './python/application-bundle.js';
import type { PythonEnvironmentPlan, PythonPlatformPlan } from './python/environment-plan.js';
import { compareVersions, versionSatisfies } from './python/pep440.js';

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
  pythonOwner?: string;
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
    npm_config_trust_lockfile: 'true',
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_REPLACE_REGISTRY_HOST: 'npmjs',
    NPM_CONFIG_REGISTRY: options.registryUrl,
    NPM_CONFIG_STORE_DIR: pnpmStore,
    NPM_CONFIG_TRUST_LOCKFILE: 'true',
    YARN_CACHE_FOLDER: yarnCache,
  };
}

function localPythonPlatformMatches(environment: PythonTargetEnvironmentConfig): boolean {
  const osMatches =
    (process.platform === 'linux' && environment.os === 'linux') ||
    (process.platform === 'darwin' && environment.os === 'macos') ||
    (process.platform === 'win32' && environment.os === 'windows');
  const archMatches =
    (process.arch === 'x64' && environment.arch === 'x86_64') ||
    (process.arch === 'arm64' && environment.arch === 'aarch64');
  return osMatches && archMatches;
}

async function verifyPythonInstall(options: {
  env: NodeJS.ProcessEnv;
  indexUrl: string;
  manifest: PythonSeedManifest;
  runner: InstallCommandRunner;
  tempRoot: string;
  timeoutMs: number;
}): Promise<VerifyInstallProjectResult> {
  const candidates = process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
  for (const command of candidates) {
    const versionResult = await options.runner({
      args: ['--version'],
      command,
      cwd: options.tempRoot,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    if (versionResult.exitCode !== 0) {
      continue;
    }
    const version = /Python\s+(\d+\.\d+\.\d+)/i.exec(
      `${versionResult.stdout}\n${versionResult.stderr}`
    )?.[1];
    const environment = options.manifest.targetEnvironments.find(
      (item) => item.pythonVersion === version && localPythonPlatformMatches(item)
    );
    if (!environment) {
      continue;
    }
    const requirements = options.manifest.packages
      .filter((pkg) => pkg.files.some((file) => file.environments.includes(environment.name)))
      .map((pkg) => `${pkg.name}==${pkg.version}`)
      .sort();
    if (requirements.length === 0) {
      return {
        packageManager: 'pip',
        projectPath: `python:${environment.name}`,
        reason: 'No bundled Python packages apply to the matching target environment',
        status: 'skipped',
        targetUrl: options.indexUrl,
      };
    }
    const venvPath = path.join(options.tempRoot, 'python-venv');
    const create = await options.runner({
      args: ['-m', 'venv', venvPath],
      command,
      cwd: options.tempRoot,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    if (create.exitCode !== 0) {
      const output = `${create.stdout}\n${create.stderr}`;
      if (/ensurepip|python\S*-venv|no module named ['"]?venv/i.test(output)) {
        return {
          command: [command, '-m', 'venv', venvPath],
          exitCode: create.exitCode,
          packageManager: 'pip',
          projectPath: `python:${environment.name}`,
          reason:
            'Matching Python interpreter is present but venv/ensurepip support is unavailable',
          status: 'skipped',
          stderr: truncateOutput(create.stderr),
          stdout: truncateOutput(create.stdout),
          targetUrl: options.indexUrl,
        };
      }
      return {
        command: [command, '-m', 'venv', venvPath],
        exitCode: create.exitCode,
        packageManager: 'pip',
        projectPath: `python:${environment.name}`,
        status: 'failed',
        stderr: truncateOutput(create.stderr),
        stdout: truncateOutput(create.stdout),
        targetUrl: options.indexUrl,
      };
    }
    const python =
      process.platform === 'win32'
        ? path.join(venvPath, 'Scripts', 'python.exe')
        : path.join(venvPath, 'bin', 'python');
    const args = [
      '-m',
      'pip',
      'install',
      '--index-url',
      options.indexUrl,
      '--only-binary',
      ':all:',
      '--no-deps',
      ...requirements,
    ];
    const install = await options.runner({
      args,
      command: python,
      cwd: options.tempRoot,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    return {
      command: [python, ...args],
      exitCode: install.exitCode,
      packageManager: 'pip',
      projectPath: `python:${environment.name}`,
      status: install.exitCode === 0 ? 'passed' : 'failed',
      stderr: truncateOutput(install.stderr),
      stdout: truncateOutput(install.stdout),
      targetUrl: options.indexUrl,
      tempPath: venvPath,
    };
  }
  return {
    packageManager: 'pip',
    projectPath: 'python',
    reason: 'No local Python interpreter exactly matches a configured target environment',
    status: 'skipped',
    targetUrl: options.indexUrl,
  };
}

interface PythonInterpreterCommand {
  command: string;
  prefixArgs: string[];
}

function localPythonPlatformFamilyId(): string | undefined {
  if (process.arch !== 'x64') {
    return undefined;
  }
  if (process.platform === 'win32') {
    return 'windows-x86_64';
  }
  if (process.platform === 'linux') {
    return 'linux-glibc-x86_64';
  }
  return undefined;
}

function localGlibcVersion(): string | undefined {
  const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } })
    .header;
  return typeof header?.glibcVersionRuntime === 'string' ? header.glibcVersionRuntime : undefined;
}

function interpreterCandidates(pythonMinor: string): PythonInterpreterCommand[] {
  return process.platform === 'win32'
    ? [
        { command: 'py', prefixArgs: [`-${pythonMinor}`] },
        { command: `python${pythonMinor}`, prefixArgs: [] },
        { command: 'python', prefixArgs: [] },
      ]
    : [
        { command: `python${pythonMinor}`, prefixArgs: [] },
        { command: 'python3', prefixArgs: [] },
        { command: 'python', prefixArgs: [] },
      ];
}

async function findMatchingInterpreter(options: {
  branch: PythonPlatformPlan;
  env: NodeJS.ProcessEnv;
  runner: InstallCommandRunner;
  tempRoot: string;
  timeoutMs: number;
}): Promise<PythonInterpreterCommand | undefined> {
  for (const candidate of interpreterCandidates(options.branch.pythonMinor)) {
    const result = await options.runner({
      args: [...candidate.prefixArgs, '--version'],
      command: candidate.command,
      cwd: options.tempRoot,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    if (result.exitCode !== 0) {
      continue;
    }
    const version = /Python\s+(\d+\.\d+\.\d+)/iu.exec(`${result.stdout}\n${result.stderr}`)?.[1];
    if (
      version?.startsWith(`${options.branch.pythonMinor}.`) &&
      versionSatisfies(version, options.branch.requiresPython)
    ) {
      return candidate;
    }
  }
  return undefined;
}

async function verifyPythonApplicationInstall(options: {
  application: PythonApplicationBundleEntry;
  bundleDir: string;
  env: NodeJS.ProcessEnv;
  indexUrl: string;
  runner: InstallCommandRunner;
  tempRoot: string;
  timeoutMs: number;
}): Promise<VerifyInstallProjectResult> {
  const plan = await fs.readJson<PythonEnvironmentPlan>(
    path.join(options.bundleDir, options.application.planPath)
  );
  const platformFamilyId = localPythonPlatformFamilyId();
  const branch = plan.platforms.find(
    (candidate) => candidate.platformFamilyId === platformFamilyId
  );
  const subject = `python-app:${options.application.targetId}`;
  if (!branch) {
    return {
      packageManager: 'pip',
      projectPath: subject,
      reason: `This verifier does not match a planned platform branch (${platformFamilyId ?? `${process.platform}/${process.arch}`})`,
      status: 'skipped',
      targetUrl: options.indexUrl,
    };
  }
  const glibcVersion = localGlibcVersion();
  if (
    branch.supportBoundary?.glibc &&
    (!glibcVersion || compareVersions(glibcVersion, branch.supportBoundary.glibc) < 0)
  ) {
    return {
      packageManager: 'pip',
      projectPath: subject,
      reason: `Verifier glibc ${glibcVersion ?? 'unknown'} does not satisfy >= ${branch.supportBoundary.glibc}`,
      status: 'skipped',
      targetUrl: options.indexUrl,
    };
  }
  const interpreter = await findMatchingInterpreter({
    branch,
    env: options.env,
    runner: options.runner,
    tempRoot: options.tempRoot,
    timeoutMs: options.timeoutMs,
  });
  if (!interpreter) {
    return {
      packageManager: 'pip',
      projectPath: subject,
      reason: `No externally provisioned Python ${branch.pythonMinor} interpreter is available`,
      status: 'skipped',
      targetUrl: options.indexUrl,
    };
  }
  const lock = options.application.locks.find(
    (candidate) =>
      candidate.format === 'requirements' &&
      candidate.platformFamilyId === branch.platformFamilyId &&
      candidate.pythonMinor === branch.pythonMinor
  );
  if (!lock) {
    return {
      packageManager: 'pip',
      projectPath: subject,
      reason: 'The bundle has no matching requirements lock',
      status: 'failed',
      targetUrl: options.indexUrl,
    };
  }
  const venvPath = path.join(options.tempRoot, 'python-applications', options.application.targetId);
  await fs.ensureDir(path.dirname(venvPath));
  const createArgs = [...interpreter.prefixArgs, '-m', 'venv', venvPath];
  const create = await options.runner({
    args: createArgs,
    command: interpreter.command,
    cwd: options.tempRoot,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  if (create.exitCode !== 0) {
    const output = `${create.stdout}\n${create.stderr}`;
    return {
      command: [interpreter.command, ...createArgs],
      exitCode: create.exitCode,
      packageManager: 'pip',
      projectPath: subject,
      ...(/ensurepip|python\S*-venv|no module named ['"]?venv/iu.test(output)
        ? { reason: 'Matching Python is present but venv/ensurepip support is unavailable' }
        : {}),
      status: /ensurepip|python\S*-venv|no module named ['"]?venv/iu.test(output)
        ? 'skipped'
        : 'failed',
      stderr: truncateOutput(create.stderr),
      stdout: truncateOutput(create.stdout),
      targetUrl: options.indexUrl,
    };
  }
  const python =
    process.platform === 'win32'
      ? path.join(venvPath, 'Scripts', 'python.exe')
      : path.join(venvPath, 'bin', 'python');
  const lockPath = path.join(options.bundleDir, lock.file);
  const installArgs = [
    '-m',
    'pip',
    'install',
    '--index-url',
    options.indexUrl,
    '--only-binary=:all:',
    '--no-deps',
    '--require-hashes',
    '-r',
    lockPath,
  ];
  const install = await options.runner({
    args: installArgs,
    command: python,
    cwd: options.tempRoot,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  if (install.exitCode !== 0) {
    return {
      command: [python, ...installArgs],
      exitCode: install.exitCode,
      packageManager: 'pip',
      projectPath: subject,
      status: 'failed',
      stderr: truncateOutput(install.stderr),
      stdout: truncateOutput(install.stdout),
      targetUrl: options.indexUrl,
      tempPath: venvPath,
    };
  }
  const checks = [
    { args: ['-m', 'pip', 'check'], command: python },
    ...(plan.verification?.healthChecks ?? []).map((check) => ({
      args: check.args,
      command: /^(?:python|python3)$/u.test(check.command) ? python : check.command,
    })),
  ];
  const binDirectory = path.dirname(python);
  const verificationEnv = {
    ...options.env,
    PATH: `${binDirectory}${path.delimiter}${options.env.PATH ?? ''}`,
  };
  for (const check of checks) {
    const result = await options.runner({
      args: check.args,
      command: check.command,
      cwd: options.tempRoot,
      env: verificationEnv,
      timeoutMs: options.timeoutMs,
    });
    if (result.exitCode !== 0) {
      return {
        command: [check.command, ...check.args],
        exitCode: result.exitCode,
        packageManager: 'pip',
        projectPath: subject,
        status: 'failed',
        stderr: truncateOutput(result.stderr),
        stdout: truncateOutput(result.stdout),
        targetUrl: options.indexUrl,
        tempPath: venvPath,
      };
    }
  }
  return {
    command: [python, ...installArgs],
    exitCode: 0,
    packageManager: 'pip',
    projectPath: subject,
    status: 'passed',
    stderr: truncateOutput(install.stderr),
    stdout: truncateOutput(install.stdout),
    targetUrl: options.indexUrl,
    tempPath: venvPath,
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
  const pythonManifest = (await fs.pathExists(path.join(bundleDir, 'python-seed-manifest.json')))
    ? await readPythonSeedManifest(bundleDir)
    : undefined;
  const pythonApplicationIndex = await readPythonApplicationBundleIndex(bundleDir);
  const configuredPythonOwner =
    snapshot.python?.publication?.pypiOwner ?? snapshot.python?.publication?.owner;
  const pythonOwner =
    options.pythonOwner ??
    (configuredPythonOwner?.strategy === 'fixed-owner' ? configuredPythonOwner.name : undefined) ??
    snapshot.python?.publishOwner ??
    snapshot.pythonPublishOwner;
  const pythonIndexUrl =
    (pythonManifest || pythonApplicationIndex) && pythonOwner
      ? `${normalizeBaseUrl(options.giteaBaseUrl)}/api/packages/${encodeURIComponent(pythonOwner)}/pypi/simple`
      : undefined;
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
    const legacyPythonManifest = pythonManifest
      ? {
          ...pythonManifest,
          packages: pythonManifest.packages.flatMap((pkg) => {
            const files = pkg.files.filter((file) => file.file.startsWith('python-packages/'));
            return files.length > 0 ? [{ ...pkg, files }] : [];
          }),
        }
      : undefined;
    if (legacyPythonManifest?.packages.length) {
      projects.push(
        pythonIndexUrl
          ? await verifyPythonInstall({
              env,
              indexUrl: pythonIndexUrl,
              manifest: legacyPythonManifest,
              runner,
              tempRoot,
              timeoutMs,
            })
          : {
              packageManager: 'pip',
              projectPath: 'python',
              reason: 'Python publish owner is not configured',
              status: 'skipped',
              targetUrl: options.giteaBaseUrl,
            }
      );
    }
    for (const application of pythonApplicationIndex?.applications ?? []) {
      projects.push(
        pythonIndexUrl
          ? await verifyPythonApplicationInstall({
              application,
              bundleDir,
              env,
              indexUrl: pythonIndexUrl,
              runner,
              tempRoot,
              timeoutMs,
            })
          : {
              packageManager: 'pip',
              projectPath: `python-app:${application.targetId}`,
              reason: 'Python publish owner is not configured',
              status: 'skipped',
              targetUrl: options.giteaBaseUrl,
            }
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
    ...(pythonIndexUrl ? { pythonIndexUrl } : {}),
    registryUrl: options.registryUrl,
    ...summary,
  };

  if (options.writeReport !== false) {
    await writeVerifyInstallReport(bundleDir, report);
  }

  return report;
}
