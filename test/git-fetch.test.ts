import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchGitSources,
  runGitCommand,
  type GitCommandInvocation,
  type GitCommandResult,
  type GitFetchProgressEvent,
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
      interaction: 'batch',
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

  it('forces Git and OpenSSH batch behavior for non-interactive network commands', async () => {
    const result = await runGitCommand({
      args: [
        '-c',
        'alias.show-batch=!printf "%s\\n%s\\n%s\\n" "$GIT_TERMINAL_PROMPT" "$GIT_SSH_COMMAND" "$SSH_ASKPASS_REQUIRE"',
        'show-batch',
      ],
      env: {
        GIT_SSH_COMMAND: 'ssh -i /keys/sync',
        GIT_SSH_VARIANT: 'ssh',
      },
      interaction: 'batch',
      sshTransport: true,
    });

    expect(result.stdout.trim().split('\n')).toEqual([
      '0',
      'ssh -i /keys/sync -o BatchMode=yes',
      'never',
    ]);
  });

  it('terminates Git commands that exceed their configured timeout', async () => {
    await expect(
      runGitCommand({
        args: ['-c', 'alias.wait=!node -e "setTimeout(() => {}, 1000)"', 'wait'],
        timeoutMs: 20,
      })
    ).rejects.toThrow('timed out after 20ms');
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
        interaction: 'batch',
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
        interaction: 'batch',
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
        interaction: 'batch',
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
        interaction: 'batch',
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

  it('defers failed SSH mirrors until batch work finishes and retries them interactively in order', async () => {
    const manifest: GitSourcesManifest = {
      ...sourcesManifest,
      sources: ['first', 'ready', 'third'].map((repo) => ({
        ...sourcesManifest.sources[0]!,
        host: 'git.example',
        id: `git.example/owner/${repo}`,
        localMirrorPath: `git-mirrors/git.example/owner/${repo}.git`,
        repo,
        sourceUrl: `git@git.example:owner/${repo}.git`,
      })),
    };
    const batchFetches: (() => void)[] = [];
    const interactiveOrder: string[] = [];
    const progress: GitFetchProgressEvent[] = [];
    let activeBatchFetches = 0;
    let activeInteractiveFetches = 0;
    let maxActiveBatchFetches = 0;
    let maxActiveInteractiveFetches = 0;
    let readyHeadChecked = false;

    const report = await fetchGitSources({
      bundleDir,
      concurrency: 3,
      interactiveRetry: true,
      manifest,
      onProgress(event) {
        progress.push(event);
      },
      async runner(invocation): Promise<GitCommandResult | undefined> {
        if (invocation.args[0] === 'init') {
          await fs.ensureDir(invocation.args.at(-1) ?? '');
          return undefined;
        }

        const targetIndex = invocation.args.indexOf('-C');
        const targetPath = targetIndex >= 0 ? invocation.args[targetIndex + 1] : undefined;
        const repo = targetPath ? path.basename(targetPath, '.git') : 'unknown';
        if (invocation.args.includes('fetch')) {
          expect(invocation.sshTransport).toBe(true);
          if (invocation.interaction === 'batch') {
            activeBatchFetches += 1;
            maxActiveBatchFetches = Math.max(maxActiveBatchFetches, activeBatchFetches);
            return await new Promise<GitCommandResult>((resolve, reject) => {
              batchFetches.push(() => {
                activeBatchFetches -= 1;
                if (repo === 'ready') {
                  resolve({ stderr: '', stdout: '' });
                } else {
                  reject(new Error(`batch authentication failed for ${repo}`));
                }
              });
              if (batchFetches.length === 3) {
                batchFetches.splice(0).forEach((release) => {
                  release();
                });
              }
            });
          }

          expect(invocation.interaction).toBe('interactive');
          expect(readyHeadChecked).toBe(true);
          interactiveOrder.push(repo);
          activeInteractiveFetches += 1;
          maxActiveInteractiveFetches = Math.max(
            maxActiveInteractiveFetches,
            activeInteractiveFetches
          );
          activeInteractiveFetches -= 1;
          return { stderr: '', stdout: '' };
        }
        if (invocation.args.includes('ls-remote')) {
          if (repo === 'ready' && invocation.interaction === 'batch') {
            readyHeadChecked = true;
          }
          return remoteHeadCommandResult(invocation);
        }
        if (invocation.args.includes('for-each-ref')) {
          return { stderr: '', stdout: '' };
        }
        return undefined;
      },
    });

    expect(maxActiveBatchFetches).toBe(3);
    expect(maxActiveInteractiveFetches).toBe(1);
    expect(interactiveOrder).toEqual(['first', 'third']);
    expect(progress.filter((event) => event.deferred).map((event) => event.repository)).toEqual([
      'git.example/owner/first',
      'git.example/owner/third',
    ]);
    expect(
      progress
        .filter((event) => event.interactiveRetry && !event.action)
        .map((event) => event.repository)
    ).toEqual(['git.example/owner/first', 'git.example/owner/third']);
    expect(report.errors).toEqual([]);
    expect(report.actions.map((action) => action.status)).toEqual(['cloned', 'cloned', 'cloned']);
    expect(report.actions[0]?.attempts).toEqual([
      {
        error: 'batch authentication failed for first',
        mode: 'batch',
        status: 'error',
      },
      { mode: 'interactive', status: 'success' },
    ]);
    expect(report.actions[1]?.attempts).toBeUndefined();
    expect(report.actions[2]?.attempts).toEqual([
      {
        error: 'batch authentication failed for third',
        mode: 'batch',
        status: 'error',
      },
      { mode: 'interactive', status: 'success' },
    ]);
  });

  it('keeps failed SSH mirrors as errors when interactive retry is disabled', async () => {
    const manifest: GitSourcesManifest = {
      ...sourcesManifest,
      sources: [
        {
          ...sourcesManifest.sources[0]!,
          sourceUrl: 'ssh://git@git.example/owner/repo.git',
        },
      ],
    };
    const interactions: GitCommandInvocation['interaction'][] = [];

    const report = await fetchGitSources({
      bundleDir,
      interactiveRetry: false,
      manifest,
      runner(invocation): Promise<GitCommandResult | undefined> {
        if (invocation.args.includes('fetch')) {
          interactions.push(invocation.interaction);
          return Promise.reject(new Error('Host key verification failed'));
        }
        return Promise.resolve(undefined);
      },
    });

    expect(interactions).toEqual(['batch']);
    expect(report.errors).toHaveLength(1);
    expect(report.actions[0]?.attempts).toBeUndefined();
  });

  it('compares an interactive retry with refs from before the failed batch attempt', async () => {
    const targetPath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(targetPath);
    const manifest: GitSourcesManifest = {
      ...sourcesManifest,
      sources: [
        {
          ...sourcesManifest.sources[0]!,
          sourceUrl: 'git@git.example:owner/repo.git',
        },
      ],
    };
    const refSnapshots = ['refs/heads/main old\n', 'refs/heads/main new\n'];

    const report = await fetchGitSources({
      bundleDir,
      interactiveRetry: true,
      manifest,
      runner(invocation): Promise<GitCommandResult | undefined> {
        if (invocation.args.includes('for-each-ref')) {
          return Promise.resolve({ stderr: '', stdout: refSnapshots.shift() ?? '' });
        }
        if (invocation.args.includes('ls-remote')) {
          if (invocation.interaction === 'batch') {
            return Promise.reject(new Error('batch default-branch lookup failed'));
          }
          return Promise.resolve(remoteHeadCommandResult(invocation));
        }
        return Promise.resolve(undefined);
      },
    });

    expect(refSnapshots).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.actions[0]).toMatchObject({
      changed: true,
      status: 'updated',
      updatedRefs: 1,
    });
  });

  it('preserves configured SSH commands and variants when enabling batch mode', async () => {
    const manifest: GitSourcesManifest = {
      ...sourcesManifest,
      sources: [
        {
          ...sourcesManifest.sources[0]!,
          sourceUrl: 'git@git.example:owner/repo.git',
        },
      ],
    };
    let fetchCall: GitCommandInvocation | undefined;

    await fetchGitSources({
      bundleDir,
      manifest,
      runner(invocation) {
        if (
          invocation.args.includes('--get-regexp') &&
          invocation.args.includes('^(core\\.sshcommand|ssh\\.variant)$')
        ) {
          return Promise.resolve({
            stderr: '',
            stdout: 'core.sshcommand ssh -i /keys/sync\nssh.variant ssh\n',
          });
        }
        if (invocation.args.includes('fetch')) {
          fetchCall = invocation;
        }
        return Promise.resolve(remoteHeadCommandResult(invocation));
      },
    });

    expect(fetchCall).toMatchObject({
      interaction: 'batch',
      sshCommand: 'ssh -i /keys/sync',
      sshTransport: true,
      sshVariant: 'ssh',
    });
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
