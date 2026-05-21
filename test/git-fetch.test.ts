import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchGitMirrors, type GitCommandInvocation } from '../src/core/git-fetch.js';
import type { GitMirrorPlan } from '../src/types.js';

let bundleDir: string;

const plan: GitMirrorPlan = {
  schemaVersion: 1,
  createdAt: '2026-05-20T00:00:00.000Z',
  giteaBaseUrl: 'http://gitea.local',
  owner: 'npm-mirrors',
  repositories: [
    {
      id: 'github.com/owner/repo',
      insteadOf: ['https://github.com/owner/repo.git'],
      repository: 'github.com-owner-repo',
      requirements: [],
      sourceUrl: 'https://github.com/owner/repo.git',
      targetUrl: 'http://gitea.local/npm-mirrors/github.com-owner-repo.git',
    },
  ],
  skipped: [],
};

describe('fetchGitMirrors', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-git-fetch-'));
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('plans mirror fetches without running git in dry-run mode', async () => {
    const calls: GitCommandInvocation[] = [];
    const report = await fetchGitMirrors({
      bundleDir,
      dryRun: true,
      generatedAt: '2026-05-20T00:00:00.000Z',
      plan,
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
      generatedAt: '2026-05-20T00:00:00.000Z',
      mirrorsDir: path.join(bundleDir, 'git-mirrors'),
      planned: 1,
      totalRepositories: 1,
      updated: 0,
    });
  });

  it('clones missing mirror repositories', async () => {
    const calls: GitCommandInvocation[] = [];
    const report = await fetchGitMirrors({
      bundleDir,
      generatedAt: '2026-05-20T00:00:00.000Z',
      plan,
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
          path.join(bundleDir, 'git-mirrors/github.com-owner-repo.git'),
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

  it('updates existing mirror repositories', async () => {
    const targetPath = path.join(bundleDir, 'git-mirrors/github.com-owner-repo.git');
    await fs.ensureDir(targetPath);
    const calls: GitCommandInvocation[] = [];

    const report = await fetchGitMirrors({
      bundleDir,
      generatedAt: '2026-05-20T00:00:00.000Z',
      plan,
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
    const report = await fetchGitMirrors({
      bundleDir,
      generatedAt: '2026-05-20T00:00:00.000Z',
      plan,
      runner: () => Promise.reject(new Error('network unavailable')),
    });

    expect(report).toMatchObject({
      cloned: 0,
      errors: [
        {
          error: 'network unavailable',
          repository: 'github.com-owner-repo',
          sourceUrl: 'https://github.com/owner/repo.git',
          status: 'error',
          targetPath: path.join(bundleDir, 'git-mirrors/github.com-owner-repo.git'),
        },
      ],
      updated: 0,
    });
  });
});
