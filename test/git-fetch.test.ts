import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
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
      cloned: 0,
      dryRun: true,
      errors: [],
      generatedAt: '2026-05-21T00:00:00.000Z',
      mirrorsDir: path.join(bundleDir, 'git-mirrors'),
      planned: 1,
      totalRepositories: 1,
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
        args: [
          'clone',
          '--mirror',
          'https://github.com/owner/repo.git',
          path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'),
        ],
      },
    ]);
    expect(report).toMatchObject({
      cloned: 1,
      dryRun: false,
      errors: [],
      planned: 0,
      totalRepositories: 1,
      updated: 0,
    });
  });

  it('updates existing source mirrors', async () => {
    const targetPath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(targetPath);
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
        args: ['-C', targetPath, 'remote', 'update', '--prune'],
      },
    ]);
    expect(report).toMatchObject({
      cloned: 0,
      errors: [],
      updated: 1,
    });
  });

  it('records git command failures without stopping the whole report', async () => {
    const report = await fetchGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      manifest: sourcesManifest,
      runner: () => Promise.reject(new Error('network unavailable')),
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
        args: [
          'clone',
          '--mirror',
          'https://github.com/owner/repo.git',
          path.join(mirrorsDir, 'github.com/owner/repo.git'),
        ],
      },
    ]);
  });
});
