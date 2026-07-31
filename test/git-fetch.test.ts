import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchGitSources,
  runGitCommand,
  type GitCommandInvocation,
  type GitCommandResult,
} from '../src/core/git-fetch.js';
import type { GitSourcesManifest } from '../src/types.js';

let bundleDir: string;

const sourcesManifest: GitSourcesManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-21T00:00:00.000Z',
  sources: [
    {
      host: 'github.com',
      id: 'github.com/owner/repo',
      localMirrorPath: 'git-mirrors/github.com/owner/repo.git',
      owner: 'owner',
      repo: 'repo',
      requirements: [],
      sourceUrl: 'https://github.com/owner/repo.git',
    },
  ],
  skipped: [],
};

function mirrorGitArgs(mirrorPath: string, args: string[]): string[] {
  return ['-c', `safe.directory=${mirrorPath}`, '-C', mirrorPath, ...args];
}

function remoteHeadCommandResult(
  invocation: GitCommandInvocation
): { stderr: string; stdout: string } | undefined {
  return invocation.args.includes('ls-remote')
    ? {
        stderr: '',
        stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
      }
    : undefined;
}

function mirrorHeadSyncCalls(mirrorPath: string): GitCommandInvocation[] {
  return [
    {
      args: mirrorGitArgs(mirrorPath, ['ls-remote', '--symref', 'origin', 'HEAD']),
    },
    {
      args: mirrorGitArgs(mirrorPath, ['show-ref', '--verify', '--quiet', 'refs/heads/main']),
    },
    {
      args: mirrorGitArgs(mirrorPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']),
    },
  ];
}

function mirrorConfigCheckCall(mirrorPath: string): GitCommandInvocation {
  return {
    args: mirrorGitArgs(mirrorPath, ['config', '--get-regexp', '^remote\\.origin\\.(url|fetch)$']),
  };
}

describe('fetchGitSources', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-git-fetch-'));
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('plans source mirror fetches without running git in dry-run mode', async () => {
    const calls: GitCommandInvocation[] = [];
    const report = await fetchGitSources({
      bundleDir,
      dryRun: true,
      generatedAt: '2026-05-21T00:00:00.000Z',
      manifest: sourcesManifest,
      runner: (invocation) => {
        calls.push(invocation);
        return Promise.resolve(remoteHeadCommandResult(invocation));
      },
    });

    expect(calls).toEqual([]);
    expect(report).toEqual({
      actions: [
        {
          repository: 'github.com/owner/repo',
          sourceUrl: 'https://github.com/owner/repo.git',
          status: 'planned',
          targetPath: path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'),
        },
      ],
      changed: 0,
      cloned: 0,
      dryRun: true,
      errors: [],
      generatedAt: '2026-05-21T00:00:00.000Z',
      mirrorsDir: path.join(bundleDir, 'git-mirrors'),
      planned: 1,
      totalRepositories: 1,
      unchanged: 0,
      updated: 0,
    });
  });

  it('clones source mirrors into preserved host and owner paths', async () => {
    const calls: GitCommandInvocation[] = [];
    const report = await fetchGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      manifest: sourcesManifest,
      runner: (invocation) => {
        calls.push(invocation);
        return Promise.resolve(remoteHeadCommandResult(invocation));
      },
    });

    expect(calls).toEqual([
      {
        args: ['init', '--bare', path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git')],
      },
      {
        args: [
          '-c',
          `safe.directory=${path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git')}`,
          '-C',
          path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'),
          'remote',
          'add',
          'origin',
          'https://github.com/owner/repo.git',
        ],
      },
      {
        args: mirrorGitArgs(path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'), [
          'config',
          '--replace-all',
          'remote.origin.fetch',
          '+refs/heads/*:refs/heads/*',
        ]),
      },
      {
        args: mirrorGitArgs(path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'), [
          'config',
          '--add',
          'remote.origin.fetch',
          '+refs/tags/*:refs/tags/*',
        ]),
      },
      {
        args: mirrorGitArgs(path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'), [
          'fetch',
          '--prune',
          'origin',
        ]),
      },
      ...mirrorHeadSyncCalls(path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git')),
    ]);
    expect(report).toMatchObject({
      changed: 1,
      cloned: 1,
      dryRun: false,
      errors: [],
      planned: 0,
      totalRepositories: 1,
      unchanged: 0,
      updated: 0,
    });
  });

  it('updates existing source mirrors and records unchanged refs', async () => {
    const targetPath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(targetPath);
    const calls: GitCommandInvocation[] = [];

    const report = await fetchGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      manifest: sourcesManifest,
      runner: (invocation) => {
        calls.push(invocation);
        return Promise.resolve(
          invocation.args.includes('for-each-ref')
            ? { stderr: '', stdout: 'refs/heads/main abc123\n' }
            : remoteHeadCommandResult(invocation)
        );
      },
    });

    expect(calls).toEqual([
      {
        args: mirrorGitArgs(targetPath, [
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads',
          'refs/tags',
        ]),
      },
      mirrorConfigCheckCall(targetPath),
      {
        args: mirrorGitArgs(targetPath, [
          'remote',
          'set-url',
          'origin',
          'https://github.com/owner/repo.git',
        ]),
      },
      {
        args: mirrorGitArgs(targetPath, [
          'config',
          '--replace-all',
          'remote.origin.fetch',
          '+refs/heads/*:refs/heads/*',
        ]),
      },
      {
        args: mirrorGitArgs(targetPath, [
          'config',
          '--add',
          'remote.origin.fetch',
          '+refs/tags/*:refs/tags/*',
        ]),
      },
      {
        args: mirrorGitArgs(targetPath, ['fetch', '--prune', 'origin']),
      },
      ...mirrorHeadSyncCalls(targetPath),
      {
        args: mirrorGitArgs(targetPath, [
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads',
          'refs/tags',
        ]),
      },
    ]);
    expect(report).toMatchObject({
      changed: 0,
      cloned: 0,
      errors: [],
      unchanged: 1,
      updated: 1,
    });
    expect(report.actions[0]).toMatchObject({
      changed: false,
      repository: 'github.com/owner/repo',
      status: 'updated',
    });
  });

  it('records updated refs and new commits for changed source mirrors', async () => {
    const targetPath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(targetPath);
    const calls: GitCommandInvocation[] = [];
    const refSnapshots = ['refs/heads/main old\n', 'refs/heads/main new\nrefs/tags/v1 tag\n'];

    const report = await fetchGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      manifest: sourcesManifest,
      runner: (invocation) => {
        calls.push(invocation);
        if (invocation.args.includes('for-each-ref')) {
          return Promise.resolve({ stderr: '', stdout: refSnapshots.shift() ?? '' });
        }
        if (invocation.args.includes('rev-list')) {
          return Promise.resolve({ stderr: '', stdout: '3\n' });
        }
        return Promise.resolve(remoteHeadCommandResult(invocation));
      },
    });

    expect(calls).toEqual([
      {
        args: mirrorGitArgs(targetPath, [
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads',
          'refs/tags',
        ]),
      },
      mirrorConfigCheckCall(targetPath),
      {
        args: mirrorGitArgs(targetPath, [
          'remote',
          'set-url',
          'origin',
          'https://github.com/owner/repo.git',
        ]),
      },
      {
        args: mirrorGitArgs(targetPath, [
          'config',
          '--replace-all',
          'remote.origin.fetch',
          '+refs/heads/*:refs/heads/*',
        ]),
      },
      {
        args: mirrorGitArgs(targetPath, [
          'config',
          '--add',
          'remote.origin.fetch',
          '+refs/tags/*:refs/tags/*',
        ]),
      },
      {
        args: mirrorGitArgs(targetPath, ['fetch', '--prune', 'origin']),
      },
      ...mirrorHeadSyncCalls(targetPath),
      {
        args: mirrorGitArgs(targetPath, [
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads',
          'refs/tags',
        ]),
      },
      {
        args: mirrorGitArgs(targetPath, ['rev-list', '--count', 'old..new']),
      },
    ]);
    expect(report).toMatchObject({
      changed: 1,
      cloned: 0,
      errors: [],
      unchanged: 0,
      updated: 1,
    });
    expect(report.actions[0]).toMatchObject({
      addedRefs: 1,
      changed: true,
      deletedRefs: 0,
      newCommits: 3,
      repository: 'github.com/owner/repo',
      status: 'updated',
      updatedRefs: 1,
    });
  });

  it('records git command failures without stopping the whole report', async () => {
    const report = await fetchGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      manifest: sourcesManifest,
      runner: () => Promise.reject<undefined>(new Error('network unavailable')),
    });

    expect(report).toMatchObject({
      cloned: 0,
      errors: [
        {
          error: 'network unavailable',
          repository: 'github.com/owner/repo',
          sourceUrl: 'https://github.com/owner/repo.git',
          status: 'error',
          targetPath: path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'),
        },
      ],
      updated: 0,
    });
  });

  it('uses a custom mirrors directory with source relative paths', async () => {
    const mirrorsDir = path.join(bundleDir, 'custom-mirrors');
    const calls: GitCommandInvocation[] = [];

    await fetchGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      manifest: sourcesManifest,
      mirrorsDir,
      runner: (invocation) => {
        calls.push(invocation);
        return Promise.resolve(remoteHeadCommandResult(invocation));
      },
    });

    expect(calls).toEqual([
      {
        args: ['init', '--bare', path.join(mirrorsDir, 'github.com/owner/repo.git')],
      },
      {
        args: [
          '-c',
          `safe.directory=${path.join(mirrorsDir, 'github.com/owner/repo.git')}`,
          '-C',
          path.join(mirrorsDir, 'github.com/owner/repo.git'),
          'remote',
          'add',
          'origin',
          'https://github.com/owner/repo.git',
        ],
      },
      {
        args: mirrorGitArgs(path.join(mirrorsDir, 'github.com/owner/repo.git'), [
          'config',
          '--replace-all',
          'remote.origin.fetch',
          '+refs/heads/*:refs/heads/*',
        ]),
      },
      {
        args: mirrorGitArgs(path.join(mirrorsDir, 'github.com/owner/repo.git'), [
          'config',
          '--add',
          'remote.origin.fetch',
          '+refs/tags/*:refs/tags/*',
        ]),
      },
      {
        args: mirrorGitArgs(path.join(mirrorsDir, 'github.com/owner/repo.git'), [
          'fetch',
          '--prune',
          'origin',
        ]),
      },
      ...mirrorHeadSyncCalls(path.join(mirrorsDir, 'github.com/owner/repo.git')),
    ]);
  });

  it('fetches independent mirrors concurrently while keeping report order stable', async () => {
    const manifest: GitSourcesManifest = {
      ...sourcesManifest,
      sources: [
        sourcesManifest.sources[0]!,
        {
          ...sourcesManifest.sources[0]!,
          id: 'github.com/owner/second',
          localMirrorPath: 'git-mirrors/github.com/owner/second.git',
          repo: 'second',
          sourceUrl: 'https://github.com/owner/second.git',
        },
      ],
    };
    const blockedFetches: (() => void)[] = [];
    let activeFetches = 0;
    let maxActiveFetches = 0;

    const report = await fetchGitSources({
      bundleDir,
      concurrency: 2,
      manifest,
      runner: (invocation) => {
        if (invocation.args.includes('fetch')) {
          activeFetches += 1;
          maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
          return new Promise<GitCommandResult>((resolve) => {
            blockedFetches.push(() => {
              activeFetches -= 1;
              resolve({ stderr: '', stdout: '' });
            });
            if (blockedFetches.length === 2) {
              blockedFetches.splice(0).forEach((release) => {
                release();
              });
            }
          });
        }
        return Promise.resolve(remoteHeadCommandResult(invocation) ?? { stderr: '', stdout: '' });
      },
    });

    expect(maxActiveFetches).toBe(2);
    expect(report.actions.map((action) => action.repository)).toEqual([
      'github.com/owner/repo',
      'github.com/owner/second',
    ]);
  });

  it('does not rewrite an already correct mirror remote configuration', async () => {
    const targetPath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(targetPath);
    const calls: GitCommandInvocation[] = [];

    await fetchGitSources({
      bundleDir,
      manifest: sourcesManifest,
      runner: (invocation) => {
        calls.push(invocation);
        if (invocation.args.includes('--get-regexp')) {
          return Promise.resolve({
            stderr: '',
            stdout: [
              'remote.origin.url https://github.com/owner/repo.git',
              'remote.origin.fetch +refs/heads/*:refs/heads/*',
              'remote.origin.fetch +refs/tags/*:refs/tags/*',
            ].join('\n'),
          });
        }
        if (invocation.args.includes('for-each-ref')) {
          return Promise.resolve({ stderr: '', stdout: 'refs/heads/main abc123\n' });
        }
        return Promise.resolve(remoteHeadCommandResult(invocation) ?? { stderr: '', stdout: '' });
      },
    });

    expect(calls.some((call) => call.args.includes('set-url'))).toBe(false);
    expect(calls.filter((call) => call.args.includes('--replace-all'))).toHaveLength(0);
    expect(calls.filter((call) => call.args.includes('--get-regexp'))).toHaveLength(1);
  });

  it('sets and repairs a mirror HEAD from the upstream default branch', async () => {
    const upstreamPath = path.join(bundleDir, 'upstream');
    await runGitCommand({
      args: ['init', '--initial-branch=main', upstreamPath],
    });
    await fs.writeFile(path.join(upstreamPath, 'package.json'), '{}\n');
    await runGitCommand({
      args: ['-C', upstreamPath, 'add', 'package.json'],
    });
    await runGitCommand({
      args: [
        '-c',
        'user.name=Airgap Sync Test',
        '-c',
        'user.email=airgap-sync@example.invalid',
        '-C',
        upstreamPath,
        'commit',
        '-m',
        'Initial commit',
      ],
    });

    const manifest: GitSourcesManifest = {
      ...sourcesManifest,
      sources: [
        {
          ...sourcesManifest.sources[0]!,
          sourceUrl: upstreamPath,
        },
      ],
    };
    await fetchGitSources({
      bundleDir,
      manifest,
    });

    const mirrorPath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    const clonedHead = await runGitCommand({
      args: ['--git-dir', mirrorPath, 'symbolic-ref', 'HEAD'],
    });
    expect(clonedHead.stdout.trim()).toBe('refs/heads/main');

    await runGitCommand({
      args: ['--git-dir', mirrorPath, 'symbolic-ref', 'HEAD', 'refs/heads/master'],
    });
    await fetchGitSources({
      bundleDir,
      manifest,
    });

    const migratedHead = await runGitCommand({
      args: ['--git-dir', mirrorPath, 'symbolic-ref', 'HEAD'],
    });
    expect(migratedHead.stdout.trim()).toBe('refs/heads/main');
  });
});
