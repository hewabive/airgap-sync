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
}

export interface GitCommandResult {
  stderr: string;
  stdout: string;
}

export type GitCommandRunner = (
  invocation: GitCommandInvocation
) => Promise<GitCommandResult | undefined> | Promise<void>;

export interface FetchGitSourcesOptions {
  bundleDir: string;
  concurrency?: number;
  dryRun?: boolean;
  generatedAt?: string;
  manifest: GitSourcesManifest;
  mirrorsDir?: string;
  onProgress?: (event: GitFetchProgressEvent) => void;
  runner?: GitCommandRunner;
}

export type GitFetchProgressStatus = 'start' | 'progress' | 'done';

export interface GitFetchProgressEvent {
  action?: GitFetchActionResult;
  current: number;
  repository?: string;
  status: GitFetchProgressStatus;
  total: number;
}

interface FetchEntry {
  id: string;
  sourceUrl: string;
  targetPath: string;
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

export async function runGitCommand(invocation: GitCommandInvocation): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve, reject) => {
    const child = spawn('git', invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, ...invocation.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
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

async function fetchMirrorRefs(targetPath: string, runner: GitCommandRunner): Promise<void> {
  await runner({
    args: safeDirectoryGitArgs(targetPath, ['-C', targetPath, 'fetch', '--prune', 'origin']),
  });
  const remoteHead = await runner({
    args: safeDirectoryGitArgs(targetPath, [
      '-C',
      targetPath,
      'ls-remote',
      '--symref',
      'origin',
      'HEAD',
    ]),
  });
  if (!remoteHead) {
    return;
  }

  const remoteHeadRef = parseRemoteHeadRef(remoteHead.stdout);
  if (!remoteHeadRef) {
    return;
  }

  await runner({
    args: safeDirectoryGitArgs(targetPath, [
      '-C',
      targetPath,
      'show-ref',
      '--verify',
      '--quiet',
      remoteHeadRef,
    ]),
  });
  await runner({
    args: safeDirectoryGitArgs(targetPath, [
      '-C',
      targetPath,
      'symbolic-ref',
      'HEAD',
      remoteHeadRef,
    ]),
  });
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
  runner: GitCommandRunner
): Promise<GitFetchActionResult> {
  try {
    if (await fs.pathExists(entry.targetPath)) {
      const before = await refsSnapshot(entry.targetPath, runner);
      await ensureMirrorRemote(entry, runner);
      await fetchMirrorRefs(entry.targetPath, runner);
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
        repository: entry.id,
        sourceUrl: entry.sourceUrl,
        status: 'updated',
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
    await fetchMirrorRefs(entry.targetPath, runner);
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
    let completed = 0;
    const results = await mapConcurrent(options.entries, options.concurrency, async (entry) => {
      const action = await fetchEntry(entry, runner);
      completed += 1;
      options.onProgress?.({
        action,
        current: completed,
        repository: entry.id,
        status: 'progress',
        total: options.entries.length,
      });
      return action;
    });
    actions.push(...results);
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
    mirrorsDir,
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
  });
}
