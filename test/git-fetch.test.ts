import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchGitSources, type GitCommandInvocation } from '../src/core/git-fetch.js';
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
        return Promise.resolve();
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
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      {
        args: ['init', '--bare', path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git')],
      },
      {
        args: [
          '-C',
          path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'),
          'remote',
          'add',
          'origin',
          'https://github.com/owner/repo.git',
        ],
      },
      {
        args: [
          '-C',
          path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'),
          'config',
          '--replace-all',
          'remote.origin.fetch',
          '+refs/heads/*:refs/heads/*',
        ],
      },
      {
        args: [
          '-C',
          path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'),
          'config',
          '--add',
          'remote.origin.fetch',
          '+refs/tags/*:refs/tags/*',
        ],
      },
      {
        args: [
          '-C',
          path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'),
          'fetch',
          '--prune',
          'origin',
        ],
      },
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
            : undefined
        );
      },
    });

    expect(calls).toEqual([
      {
        args: [
          '-C',
          targetPath,
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads',
          'refs/tags',
        ],
      },
      {
        args: [
          '-C',
          targetPath,
          'remote',
          'set-url',
          'origin',
          'https://github.com/owner/repo.git',
        ],
      },
      {
        args: [
          '-C',
          targetPath,
          'config',
          '--replace-all',
          'remote.origin.fetch',
          '+refs/heads/*:refs/heads/*',
        ],
      },
      {
        args: [
          '-C',
          targetPath,
          'config',
          '--add',
          'remote.origin.fetch',
          '+refs/tags/*:refs/tags/*',
        ],
      },
      {
        args: ['-C', targetPath, 'fetch', '--prune', 'origin'],
      },
      {
        args: [
          '-C',
          targetPath,
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads',
          'refs/tags',
        ],
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
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      {
        args: ['init', '--bare', path.join(mirrorsDir, 'github.com/owner/repo.git')],
      },
      {
        args: [
          '-C',
          path.join(mirrorsDir, 'github.com/owner/repo.git'),
          'remote',
          'add',
          'origin',
          'https://github.com/owner/repo.git',
        ],
      },
      {
        args: [
          '-C',
          path.join(mirrorsDir, 'github.com/owner/repo.git'),
          'config',
          '--replace-all',
          'remote.origin.fetch',
          '+refs/heads/*:refs/heads/*',
        ],
      },
      {
        args: [
          '-C',
          path.join(mirrorsDir, 'github.com/owner/repo.git'),
          'config',
          '--add',
          'remote.origin.fetch',
          '+refs/tags/*:refs/tags/*',
        ],
      },
      {
        args: [
          '-C',
          path.join(mirrorsDir, 'github.com/owner/repo.git'),
          'fetch',
          '--prune',
          'origin',
        ],
      },
    ]);
  });
});
