import path from 'node:path';
import * as fs from './fs.js';
import { type GitCommandRunner, runGitCommand } from './git-fetch.js';

export const workspaceConfigFileName = 'airgap-sync.json';
export const defaultWorkspaceOutputDir = './airgap-bundle';
export const defaultWorkspaceReposDir = './repos';
export const defaultWorkspaceSourceRegistry = 'https://registry.npmjs.org';

export interface WorkspaceGitTarget {
  branch?: string;
  type: 'git';
  url: string;
}

export interface WorkspaceNpmTarget {
  spec: string;
  type: 'npm';
}

export type WorkspaceTarget = WorkspaceGitTarget | WorkspaceNpmTarget;

export interface WorkspaceConfig {
  output: string;
  reposDir: string;
  schemaVersion: 1;
  sourceRegistry: string;
  targets: WorkspaceTarget[];
}

export type WorkspaceGitTargetStatus = 'planned' | 'cloned' | 'exists' | 'error';

export interface WorkspaceGitTargetResult {
  branch?: string;
  error?: string;
  status: WorkspaceGitTargetStatus;
  targetPath: string;
  url: string;
}

export interface WorkspaceGitTargetsReport {
  cloned: number;
  dryRun: boolean;
  errors: WorkspaceGitTargetResult[];
  exists: number;
  planned: number;
  repositories: WorkspaceGitTargetResult[];
  reposDir: string;
  totalRepositories: number;
}

interface WorkspaceGitTargetSnapshot {
  branch?: string;
  error?: string;
  localPath: string;
  status?: WorkspaceGitTargetStatus;
  type: 'git';
  url: string;
}

interface WorkspaceNpmTargetSnapshot {
  spec: string;
  type: 'npm';
}

export type WorkspaceTargetSnapshot = WorkspaceGitTargetSnapshot | WorkspaceNpmTargetSnapshot;

export interface WorkspaceSnapshot {
  createdAt: string;
  output: string;
  reposDir: string;
  schemaVersion: 1;
  sourceRegistry: string;
  targets: WorkspaceTargetSnapshot[];
}

export interface InitWorkspaceOptions {
  force?: boolean;
  workspaceDir: string;
}

export interface MaterializeWorkspaceGitTargetsOptions {
  config: WorkspaceConfig;
  dryRun?: boolean;
  runner?: GitCommandRunner;
  workspaceDir: string;
}

export interface CreateWorkspaceSnapshotOptions {
  config: WorkspaceConfig;
  createdAt?: string;
  targetSync?: WorkspaceGitTargetsReport;
  workspaceDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createDefaultWorkspaceConfig(): WorkspaceConfig {
  return {
    output: defaultWorkspaceOutputDir,
    reposDir: defaultWorkspaceReposDir,
    schemaVersion: 1,
    sourceRegistry: defaultWorkspaceSourceRegistry,
    targets: [],
  };
}

export function workspaceConfigPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), workspaceConfigFileName);
}

function normalizeWorkspaceTarget(value: unknown): WorkspaceTarget {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Workspace target must be an object with a type');
  }

  if (value.type === 'git') {
    if (typeof value.url !== 'string' || value.url.trim().length === 0) {
      throw new Error('Git target must include a non-empty url');
    }

    return {
      ...(typeof value.branch === 'string' && value.branch.trim().length > 0
        ? { branch: value.branch.trim() }
        : {}),
      type: 'git',
      url: value.url.trim(),
    };
  }

  if (value.type === 'npm') {
    if (typeof value.spec !== 'string' || value.spec.trim().length === 0) {
      throw new Error('npm target must include a non-empty spec');
    }

    return {
      spec: value.spec.trim(),
      type: 'npm',
    };
  }

  throw new Error(`Unsupported workspace target type: ${value.type}`);
}

function normalizeWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (!isRecord(value)) {
    throw new Error(`${workspaceConfigFileName} must contain a JSON object`);
  }

  if (value.schemaVersion !== 1) {
    throw new Error(`${workspaceConfigFileName} schemaVersion must be 1`);
  }

  const targets = Array.isArray(value.targets)
    ? value.targets.map((target) => normalizeWorkspaceTarget(target))
    : [];

  return {
    output:
      typeof value.output === 'string' && value.output.trim().length > 0
        ? value.output.trim()
        : defaultWorkspaceOutputDir,
    reposDir:
      typeof value.reposDir === 'string' && value.reposDir.trim().length > 0
        ? value.reposDir.trim()
        : defaultWorkspaceReposDir,
    schemaVersion: 1,
    sourceRegistry:
      typeof value.sourceRegistry === 'string' && value.sourceRegistry.trim().length > 0
        ? value.sourceRegistry.trim()
        : defaultWorkspaceSourceRegistry,
    targets,
  };
}

export async function initWorkspace(options: InitWorkspaceOptions): Promise<WorkspaceConfig> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const configPath = workspaceConfigPath(workspaceDir);
  if ((await fs.pathExists(configPath)) && options.force !== true) {
    throw new Error(`${workspaceConfigFileName} already exists in ${workspaceDir}`);
  }

  const config = createDefaultWorkspaceConfig();
  await fs.writeJson(configPath, config, { spaces: 2 });
  await fs.ensureDir(path.resolve(workspaceDir, config.reposDir));
  await fs.ensureDir(path.resolve(workspaceDir, config.output));
  await fs.ensureDir(path.resolve(workspaceDir, 'cache'));
  await fs.ensureDir(path.resolve(workspaceDir, 'reports'));
  return config;
}

export async function readWorkspaceConfig(workspaceDir: string): Promise<WorkspaceConfig> {
  return normalizeWorkspaceConfig(await fs.readJson(workspaceConfigPath(workspaceDir)));
}

export async function writeWorkspaceConfig(
  workspaceDir: string,
  config: WorkspaceConfig
): Promise<void> {
  await fs.writeJson(workspaceConfigPath(workspaceDir), config, { spaces: 2 });
}

function targetKey(target: WorkspaceTarget): string {
  return target.type === 'git'
    ? ['git', target.url, target.branch ?? ''].join('\0')
    : ['npm', target.spec].join('\0');
}

export async function addWorkspaceTarget(
  workspaceDir: string,
  target: WorkspaceTarget
): Promise<{ added: boolean; config: WorkspaceConfig }> {
  const config = await readWorkspaceConfig(workspaceDir);
  const id = targetKey(target);
  const exists = config.targets.some((existing) => targetKey(existing) === id);
  if (!exists) {
    config.targets.push(target);
    await writeWorkspaceConfig(workspaceDir, config);
  }

  return { added: !exists, config };
}

export async function removeWorkspaceTarget(
  workspaceDir: string,
  index: number
): Promise<{ config: WorkspaceConfig; removed: WorkspaceTarget }> {
  const config = await readWorkspaceConfig(workspaceDir);
  if (!Number.isInteger(index) || index < 1 || index > config.targets.length) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }

  const removed = config.targets.splice(index - 1, 1)[0];
  if (!removed) {
    throw new Error(`Target index must be between 1 and ${String(config.targets.length)}`);
  }
  await writeWorkspaceConfig(workspaceDir, config);
  return { config, removed };
}

function normalizeGitRepoPathSegment(segment: string): string {
  return segment.replace(/\.git$/i, '');
}

export function gitTargetLocalPath(
  workspaceDir: string,
  config: WorkspaceConfig,
  url: string
): string {
  const scpLike = /^git@([^:]+):(.+)$/.exec(url);
  if (scpLike) {
    const host = scpLike[1] ?? 'unknown-host';
    const repoPath = (scpLike[2] ?? 'repository').split('/').map(normalizeGitRepoPathSegment);
    return path.resolve(workspaceDir, config.reposDir, host, ...repoPath);
  }

  try {
    const parsed = new URL(url);
    const repoPath = parsed.pathname
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .map(normalizeGitRepoPathSegment);
    return path.resolve(workspaceDir, config.reposDir, parsed.hostname, ...repoPath);
  } catch {
    return path.resolve(workspaceDir, config.reposDir, normalizeGitRepoPathSegment(url));
  }
}

async function materializeGitTarget(
  workspaceDir: string,
  config: WorkspaceConfig,
  target: WorkspaceGitTarget,
  dryRun: boolean,
  runner: GitCommandRunner
): Promise<WorkspaceGitTargetResult> {
  const targetPath = gitTargetLocalPath(workspaceDir, config, target.url);

  try {
    if (await fs.pathExists(targetPath)) {
      return {
        ...(target.branch ? { branch: target.branch } : {}),
        status: 'exists',
        targetPath,
        url: target.url,
      };
    }

    if (dryRun) {
      return {
        ...(target.branch ? { branch: target.branch } : {}),
        status: 'planned',
        targetPath,
        url: target.url,
      };
    }

    await fs.ensureDir(path.dirname(targetPath));
    await runner({
      args: [
        'clone',
        ...(target.branch ? ['--branch', target.branch] : []),
        target.url,
        targetPath,
      ],
    });

    return {
      ...(target.branch ? { branch: target.branch } : {}),
      status: 'cloned',
      targetPath,
      url: target.url,
    };
  } catch (error) {
    return {
      ...(target.branch ? { branch: target.branch } : {}),
      error: (error as Error).message,
      status: 'error',
      targetPath,
      url: target.url,
    };
  }
}

export async function materializeWorkspaceGitTargets(
  options: MaterializeWorkspaceGitTargetsOptions
): Promise<WorkspaceGitTargetsReport> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const reposDir = path.resolve(workspaceDir, options.config.reposDir);
  const dryRun = options.dryRun === true;
  const runner = options.runner ?? runGitCommand;
  const repositories: WorkspaceGitTargetResult[] = [];
  if (!dryRun) {
    await fs.ensureDir(reposDir);
  }

  for (const target of options.config.targets) {
    if (target.type === 'git') {
      repositories.push(
        await materializeGitTarget(workspaceDir, options.config, target, dryRun, runner)
      );
    }
  }

  const errors = repositories.filter((repository) => repository.status === 'error');

  return {
    cloned: repositories.filter((repository) => repository.status === 'cloned').length,
    dryRun,
    errors,
    exists: repositories.filter((repository) => repository.status === 'exists').length,
    planned: repositories.filter((repository) => repository.status === 'planned').length,
    repositories,
    reposDir,
    totalRepositories: repositories.length,
  };
}

function toPortablePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function matchingGitTargetResult(
  target: WorkspaceGitTarget,
  report: WorkspaceGitTargetsReport | undefined
): WorkspaceGitTargetResult | undefined {
  return report?.repositories.find(
    (repository) =>
      repository.url === target.url && (repository.branch ?? '') === (target.branch ?? '')
  );
}

export function createWorkspaceSnapshot(
  options: CreateWorkspaceSnapshotOptions
): WorkspaceSnapshot {
  const workspaceDir = path.resolve(options.workspaceDir);

  return {
    createdAt: options.createdAt ?? new Date().toISOString(),
    output: options.config.output,
    reposDir: options.config.reposDir,
    schemaVersion: 1,
    sourceRegistry: options.config.sourceRegistry,
    targets: options.config.targets.map((target) => {
      if (target.type === 'npm') {
        return {
          spec: target.spec,
          type: 'npm',
        };
      }

      const result = matchingGitTargetResult(target, options.targetSync);
      const targetPath =
        result?.targetPath ?? gitTargetLocalPath(workspaceDir, options.config, target.url);
      const localPath = toPortablePath(path.relative(workspaceDir, targetPath));

      return {
        ...(target.branch ? { branch: target.branch } : {}),
        ...(result?.error ? { error: result.error } : {}),
        localPath,
        ...(result?.status ? { status: result.status } : {}),
        type: 'git',
        url: target.url,
      };
    }),
  };
}
