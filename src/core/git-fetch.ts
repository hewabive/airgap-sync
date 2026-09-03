import { spawn } from 'node:child_process';
import path from 'node:path';
import * as fs from './fs.js';
import type { GitFetchActionResult, GitFetchReport, GitSourcesManifest } from '../types.js';
import { mapConcurrent } from './concurrency.js';
import { safeDirectoryGitArgs } from './git-safe.js';
import { gitSourceMirrorPath } from './git-targets.js';

export interface GitCommandInvocation {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  interaction?: GitCommandInteraction;
  sshCommand?: string;
  sshTransport?: boolean;
  sshVariant?: string;
  timeoutMs?: number;
}

export interface GitCommandResult {
  stderr: string;
  stdout: string;
}

export type GitCommandRunner = (
  invocation: GitCommandInvocation
) => Promise<GitCommandResult | undefined> | Promise<void>;

export type GitCommandInteraction = 'batch' | 'interactive';

export interface FetchGitSourcesOptions {
  bundleDir: string;
  concurrency?: number;
  dryRun?: boolean;
  generatedAt?: string;
  interactiveRetry?: boolean;
  manifest: GitSourcesManifest;
  mirrorsDir?: string;
  onProgress?: (event: GitFetchProgressEvent) => void;
  runner?: GitCommandRunner;
}

export type GitFetchProgressStatus = 'start' | 'progress' | 'warning' | 'done';

export interface GitFetchProgressEvent {
  action?: GitFetchActionResult;
  current: number;
  deferred?: boolean;
  interactiveRetry?: boolean;
  repository?: string;
  status: GitFetchProgressStatus;
  total: number;
}

interface FetchEntry {
  id: string;
  sshTransport: boolean;
  sourceUrl: string;
  targetPath: string;
}

interface FetchEntryState {
  baselineCaptured: boolean;
  baselineRefs: RefSnapshot | undefined;
  originallyExisted: boolean;
}

interface SshBatchConfiguration {
  command?: string;
  variant?: string;
}

const mirrorBranchRefspec = '+refs/heads/*:refs/heads/*';
const mirrorTagRefspec = '+refs/tags/*:refs/tags/*';
const mirroredRefNamespaces = ['refs/heads', 'refs/tags'];

type RefSnapshot = Map<string, string>;

interface RefChangeSummary {
  addedRefs: number;
  changed: boolean;
  deletedRefs: number;
  newCommits?: number;
  updatedRefs: number;
}

function parseRemoteHeadRef(value: string): string | undefined {
  for (const line of value.split(/\r?\n/)) {
    const match = /^ref:\s+(refs\/heads\/\S+)\s+HEAD$/.exec(line.trim());
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function redactGitArg(arg: string): string {
  return arg.startsWith('http.extraHeader=') ? 'http.extraHeader=<redacted>' : arg;
}

function shellQuote(value: string): string {
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

function batchSshCommand(env: NodeJS.ProcessEnv, configuration: SshBatchConfiguration): string {
  const configuredCommand = env.GIT_SSH_COMMAND?.trim();
  const configuredExecutable = env.GIT_SSH?.trim();
  const command =
    configuredCommand ??
    (configuredExecutable ? shellQuote(configuredExecutable) : (configuration.command ?? 'ssh'));
  const variant = env.GIT_SSH_VARIANT?.toLowerCase() ?? configuration.variant?.toLowerCase();
  const usesPlink =
    variant === 'plink' ||
    variant === 'putty' ||
    variant === 'tortoiseplink' ||
    /(?:^|[\\/\s"'])(?:tortoise)?plink(?:\.exe)?(?=\s|["']|$)/iu.test(command);

  if (variant === 'simple') {
    return command;
  }
  return usesPlink ? `${command} -batch` : `${command} -o BatchMode=yes`;
}

function commandEnvironment(invocation: GitCommandInvocation): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...invocation.env };
  if (invocation.interaction !== 'batch') {
    return env;
  }

  env.GIT_TERMINAL_PROMPT = '0';
  if (invocation.sshTransport === true) {
    env.GIT_SSH_COMMAND = batchSshCommand(env, {
      ...(invocation.sshCommand ? { command: invocation.sshCommand } : {}),
      ...(invocation.sshVariant ? { variant: invocation.sshVariant } : {}),
    });
    env.SSH_ASKPASS_REQUIRE = 'never';
  }
  return env;
}

function isSshSourceUrl(sourceUrl: string): boolean {
  const normalized = sourceUrl.replace(/^git\+/u, '');
  if (/^ssh:\/\//iu.test(normalized)) {
    return true;
  }
  return /^[^\s/@:]+@[^\s/:]+:.+/u.test(normalized);
}

export async function runGitCommand(invocation: GitCommandInvocation): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve, reject) => {
    const interactive = invocation.interaction === 'interactive';
    const child = spawn('git', invocation.args, {
      cwd: invocation.cwd,
      env: commandEnvironment(invocation),
      stdio: [interactive ? 'inherit' : 'ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeout = invocation.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
          forceKillTimer.unref();
        }, invocation.timeoutMs)
      : undefined;
    timeout?.unref();
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      if (interactive) {
        process.stderr.write(chunk);
      }
    });
    child.on('error', (error) => {
      clearTimers();
      reject(error);
    });
    child.on('close', (code) => {
      clearTimers();
      if (timedOut) {
        reject(
          new Error(
            `git ${invocation.args.map(redactGitArg).join(' ')} timed out after ${String(invocation.timeoutMs)}ms`
          )
        );
        return;
      }
      if (code === 0) {
        resolve({
          stderr: Buffer.concat(stderr).toString('utf8'),
          stdout: Buffer.concat(stdout).toString('utf8'),
        });
        return;
      }

      const message = Buffer.concat(stderr).toString('utf8').trim();
      reject(
        new Error(
          message ||
            `git ${invocation.args.map(redactGitArg).join(' ')} exited with code ${String(code)}`
        )
      );
    });
  });
}

function normalizeRefs(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
    .join('\n');
}

function parseRefs(value: string): RefSnapshot {
  const refs: RefSnapshot = new Map();
  for (const line of normalizeRefs(value).split('\n')) {
    if (!line) {
      continue;
    }
    const [refname, objectname] = line.split(/\s+/, 2);
    if (refname && objectname) {
      refs.set(refname, objectname);
    }
  }
  return refs;
}

async function refsSnapshot(
  targetPath: string,
  runner: GitCommandRunner
): Promise<RefSnapshot | undefined> {
  const result = await runner({
    args: safeDirectoryGitArgs(targetPath, [
      '-C',
      targetPath,
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      ...mirroredRefNamespaces,
    ]),
  });

  return result ? parseRefs(result.stdout) : undefined;
}

async function countNewCommits(options: {
  ranges: string[];
  runner: GitCommandRunner;
  targetPath: string;
}): Promise<number | undefined> {
  if (options.ranges.length === 0) {
    return undefined;
  }

  try {
    const result = await options.runner({
      args: safeDirectoryGitArgs(options.targetPath, [
        '-C',
        options.targetPath,
        'rev-list',
        '--count',
        ...options.ranges,
      ]),
    });

    if (!result) {
      return undefined;
    }

    const count = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

async function summarizeRefChanges(options: {
  after: RefSnapshot;
  before: RefSnapshot;
  runner: GitCommandRunner;
  targetPath: string;
}): Promise<RefChangeSummary> {
  let addedRefs = 0;
  let deletedRefs = 0;
  let updatedRefs = 0;
  const commitRanges: string[] = [];

  for (const [refname, afterObject] of options.after) {
    const beforeObject = options.before.get(refname);
    if (beforeObject === undefined) {
      addedRefs += 1;
      continue;
    }
    if (beforeObject === afterObject) {
      continue;
    }

    updatedRefs += 1;
    if (!refname.startsWith('refs/heads/')) {
      continue;
    }

    commitRanges.push(`${beforeObject}..${afterObject}`);
  }

  for (const refname of options.before.keys()) {
    if (!options.after.has(refname)) {
      deletedRefs += 1;
    }
  }

  const newCommits = await countNewCommits({
    ranges: commitRanges,
    runner: options.runner,
    targetPath: options.targetPath,
  });

  return {
    addedRefs,
    changed: addedRefs > 0 || deletedRefs > 0 || updatedRefs > 0,
    deletedRefs,
    ...(newCommits === undefined ? {} : { newCommits }),
    updatedRefs,
  };
}

async function configureMirrorFetchRefspecs(
  targetPath: string,
  runner: GitCommandRunner
): Promise<void> {
  await runner({
    args: safeDirectoryGitArgs(targetPath, [
      '-C',
      targetPath,
      'config',
      '--replace-all',
      'remote.origin.fetch',
      mirrorBranchRefspec,
    ]),
  });
  await runner({
    args: safeDirectoryGitArgs(targetPath, [
      '-C',
      targetPath,
      'config',
      '--add',
      'remote.origin.fetch',
      mirrorTagRefspec,
    ]),
  });
}

async function fetchMirrorRefs(
  entry: FetchEntry,
  runner: GitCommandRunner,
  interaction: GitCommandInteraction,
  sshConfiguration: SshBatchConfiguration
): Promise<void> {
  await runner({
    args: safeDirectoryGitArgs(entry.targetPath, [
      '-C',
      entry.targetPath,
      'fetch',
      '--prune',
      'origin',
    ]),
    interaction,
    ...(sshConfiguration.command ? { sshCommand: sshConfiguration.command } : {}),
    ...(entry.sshTransport ? { sshTransport: true } : {}),
    ...(sshConfiguration.variant ? { sshVariant: sshConfiguration.variant } : {}),
  });
  const remoteHead = await runner({
    args: safeDirectoryGitArgs(entry.targetPath, [
      '-C',
      entry.targetPath,
      'ls-remote',
      '--symref',
      'origin',
      'HEAD',
    ]),
    interaction,
    ...(sshConfiguration.command ? { sshCommand: sshConfiguration.command } : {}),
    ...(entry.sshTransport ? { sshTransport: true } : {}),
    ...(sshConfiguration.variant ? { sshVariant: sshConfiguration.variant } : {}),
  });
  if (!remoteHead) {
    return;
  }

  const remoteHeadRef = parseRemoteHeadRef(remoteHead.stdout);
  if (!remoteHeadRef) {
    return;
  }

  await runner({
    args: safeDirectoryGitArgs(entry.targetPath, [
      '-C',
      entry.targetPath,
      'show-ref',
      '--verify',
      '--quiet',
      remoteHeadRef,
    ]),
  });
  await runner({
    args: safeDirectoryGitArgs(entry.targetPath, [
      '-C',
      entry.targetPath,
      'symbolic-ref',
      'HEAD',
      remoteHeadRef,
    ]),
  });
}

async function readSshBatchConfiguration(
  entry: FetchEntry,
  runner: GitCommandRunner
): Promise<SshBatchConfiguration> {
  if (!entry.sshTransport) {
    return {};
  }
  try {
    const result = await runner({
      args: safeDirectoryGitArgs(entry.targetPath, [
        '-C',
        entry.targetPath,
        'config',
        '--get-regexp',
        '^(core\\.sshcommand|ssh\\.variant)$',
      ]),
    });
    if (!result) {
      return {};
    }
    const configuration: SshBatchConfiguration = {};
    for (const line of result.stdout.split(/\r?\n/u)) {
      const separator = line.search(/\s/u);
      if (separator < 1) {
        continue;
      }
      const key = line.slice(0, separator).toLowerCase();
      const value = line.slice(separator).trim();
      if (key === 'core.sshcommand' && value) {
        configuration.command = value;
      } else if (key === 'ssh.variant' && value) {
        configuration.variant = value;
      }
    }
    return configuration;
  } catch {
    return {};
  }
}

function configuredRemoteMatches(stdout: string, sourceUrl: string): boolean {
  const values = new Map<string, string[]>();
  for (const line of stdout.split(/\r?\n/u)) {
    const separator = line.search(/\s/u);
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator);
    const entries = values.get(key) ?? [];
    entries.push(line.slice(separator).trim());
    values.set(key, entries);
  }
  const fetchRefspecs = values.get('remote.origin.fetch') ?? [];
  return (
    values.get('remote.origin.url')?.length === 1 &&
    values.get('remote.origin.url')?.[0] === sourceUrl &&
    fetchRefspecs.length === 2 &&
    fetchRefspecs.includes(mirrorBranchRefspec) &&
    fetchRefspecs.includes(mirrorTagRefspec)
  );
}

async function ensureMirrorRemote(entry: FetchEntry, runner: GitCommandRunner): Promise<void> {
  let configured = false;
  try {
    const result = await runner({
      args: safeDirectoryGitArgs(entry.targetPath, [
        '-C',
        entry.targetPath,
        'config',
        '--get-regexp',
        '^remote\\.origin\\.(url|fetch)$',
      ]),
    });
    configured = result ? configuredRemoteMatches(result.stdout, entry.sourceUrl) : false;
  } catch {
    // A missing or malformed origin is repaired by the commands below.
  }
  if (configured) {
    return;
  }

  await runner({
    args: safeDirectoryGitArgs(entry.targetPath, [
      '-C',
      entry.targetPath,
      'remote',
      'set-url',
      'origin',
      entry.sourceUrl,
    ]),
  });
  await configureMirrorFetchRefspecs(entry.targetPath, runner);
}

async function fetchEntry(
  entry: FetchEntry,
  runner: GitCommandRunner,
  options: {
    interaction: GitCommandInteraction;
    state: FetchEntryState;
  }
): Promise<GitFetchActionResult> {
  try {
    if (await fs.pathExists(entry.targetPath)) {
      const before = options.state.baselineCaptured
        ? options.state.baselineRefs
        : await refsSnapshot(entry.targetPath, runner);
      options.state.baselineCaptured = true;
      options.state.baselineRefs = before;
      await ensureMirrorRemote(entry, runner);
      const sshConfiguration =
        options.interaction === 'batch' ? await readSshBatchConfiguration(entry, runner) : {};
      await fetchMirrorRefs(entry, runner, options.interaction, sshConfiguration);
      const after = await refsSnapshot(entry.targetPath, runner);
      const changes =
        before !== undefined && after !== undefined
          ? await summarizeRefChanges({
              after,
              before,
              runner,
              targetPath: entry.targetPath,
            })
          : undefined;
      const clonedDuringRun = !options.state.originallyExisted;
      return {
        ...(changes
          ? {
              addedRefs: changes.addedRefs,
              changed: changes.changed,
              deletedRefs: changes.deletedRefs,
              ...(changes.newCommits === undefined ? {} : { newCommits: changes.newCommits }),
              updatedRefs: changes.updatedRefs,
            }
          : {}),
        ...(clonedDuringRun ? { changed: true } : {}),
        repository: entry.id,
        sourceUrl: entry.sourceUrl,
        status: clonedDuringRun ? 'cloned' : 'updated',
        targetPath: entry.targetPath,
      };
    }

    await fs.ensureDir(path.dirname(entry.targetPath));
    await runner({
      args: ['init', '--bare', entry.targetPath],
    });
    await runner({
      args: safeDirectoryGitArgs(entry.targetPath, [
        '-C',
        entry.targetPath,
        'remote',
        'add',
        'origin',
        entry.sourceUrl,
      ]),
    });
    await configureMirrorFetchRefspecs(entry.targetPath, runner);
    const sshConfiguration =
      options.interaction === 'batch' ? await readSshBatchConfiguration(entry, runner) : {};
    await fetchMirrorRefs(entry, runner, options.interaction, sshConfiguration);
    return {
      changed: true,
      repository: entry.id,
      sourceUrl: entry.sourceUrl,
      status: 'cloned',
      targetPath: entry.targetPath,
    };
  } catch (error) {
    return {
      error: (error as Error).message,
      repository: entry.id,
      sourceUrl: entry.sourceUrl,
      status: 'error',
      targetPath: entry.targetPath,
    };
  }
}

async function fetchEntries(options: {
  concurrency?: number;
  dryRun: boolean;
  entries: FetchEntry[];
  generatedAt?: string;
  interactiveRetry: boolean;
  mirrorsDir: string;
  onProgress?: (event: GitFetchProgressEvent) => void;
  runner?: GitCommandRunner;
}): Promise<GitFetchReport> {
  const actions: GitFetchActionResult[] = [];
  options.onProgress?.({
    current: 0,
    status: 'start',
    total: options.entries.length,
  });

  if (options.dryRun) {
    for (const [index, entry] of options.entries.entries()) {
      const action: GitFetchActionResult = {
        repository: entry.id,
        sourceUrl: entry.sourceUrl,
        status: 'planned',
        targetPath: entry.targetPath,
      };
      actions.push(action);
      options.onProgress?.({
        action,
        current: index + 1,
        repository: entry.id,
        status: 'progress',
        total: options.entries.length,
      });
    }
  } else {
    const runner = options.runner ?? runGitCommand;
    let batchCompleted = 0;
    const results = await mapConcurrent(
      options.entries,
      options.concurrency,
      async (entry, index) => {
        const originallyExisted = await fs.pathExists(entry.targetPath);
        const state: FetchEntryState = {
          baselineCaptured: false,
          baselineRefs: undefined,
          originallyExisted,
        };
        const action = await fetchEntry(entry, runner, {
          interaction: 'batch',
          state,
        });
        batchCompleted += 1;
        const deferred =
          options.interactiveRetry && entry.sshTransport && action.status === 'error';
        if (!deferred) {
          options.onProgress?.({
            action,
            current: batchCompleted,
            repository: entry.id,
            status: 'progress',
            total: options.entries.length,
          });
        }
        return { action, entry, index, state };
      }
    );
    const deferred = results.filter(
      (result) =>
        options.interactiveRetry && result.entry.sshTransport && result.action.status === 'error'
    );
    let finalized = results.length - deferred.length;

    for (const result of deferred) {
      options.onProgress?.({
        action: result.action,
        current: finalized,
        deferred: true,
        repository: result.entry.id,
        status: 'warning',
        total: options.entries.length,
      });
    }

    for (const result of deferred) {
      options.onProgress?.({
        current: finalized,
        interactiveRetry: true,
        repository: result.entry.id,
        status: 'warning',
        total: options.entries.length,
      });
      const retried = await fetchEntry(result.entry, runner, {
        interaction: 'interactive',
        state: result.state,
      });
      const action: GitFetchActionResult = {
        ...retried,
        attempts: [
          {
            ...(result.action.error ? { error: result.action.error } : {}),
            mode: 'batch',
            status: 'error',
          },
          {
            ...(retried.error ? { error: retried.error } : {}),
            mode: 'interactive',
            status: retried.status === 'error' ? 'error' : 'success',
          },
        ],
      };
      results[result.index] = { ...result, action };
      finalized += 1;
      options.onProgress?.({
        action,
        current: finalized,
        interactiveRetry: true,
        repository: result.entry.id,
        status: action.status === 'error' ? 'warning' : 'progress',
        total: options.entries.length,
      });
    }
    actions.push(...results.map((result) => result.action));
  }
  options.onProgress?.({
    current: actions.length,
    status: 'done',
    total: options.entries.length,
  });

  const errors = actions.filter((action) => action.status === 'error');

  return {
    actions,
    changed: actions.filter((action) => action.changed === true).length,
    cloned: actions.filter((action) => action.status === 'cloned').length,
    dryRun: options.dryRun,
    errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mirrorsDir: options.mirrorsDir,
    planned: actions.filter((action) => action.status === 'planned').length,
    totalRepositories: actions.length,
    unchanged: actions.filter((action) => action.changed === false).length,
    updated: actions.filter((action) => action.status === 'updated').length,
  };
}

export async function fetchGitSources(options: FetchGitSourcesOptions): Promise<GitFetchReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const defaultMirrorRoot = path.join(bundleDir, 'git-mirrors');
  const mirrorsDir = path.resolve(options.mirrorsDir ?? defaultMirrorRoot);
  const entries = options.manifest.sources.map((source) => ({
    id: source.id,
    sshTransport: isSshSourceUrl(source.sourceUrl),
    sourceUrl: source.sourceUrl,
    targetPath: gitSourceMirrorPath({
      bundleDir,
      ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
      source,
    }),
  }));

  return await fetchEntries({
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    dryRun: options.dryRun === true,
    entries,
    interactiveRetry: options.interactiveRetry === true,
    mirrorsDir,
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
  });
}
