import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyGitMirrors,
  createGitConfigRewriteRules,
  type GitCommandInvocation,
} from '../src/index.js';
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
      insteadOf: ['https://github.com/owner/repo', 'https://github.com/owner/repo.git'],
      repository: 'github.com-owner-repo',
      requirements: [],
      sourceUrl: 'https://github.com/owner/repo.git',
      targetUrl: 'http://gitea.local/npm-mirrors/github.com-owner-repo.git',
    },
  ],
  skipped: [],
};

describe('createGitConfigRewriteRules', () => {
  it('creates deterministic git config commands', () => {
    expect(createGitConfigRewriteRules(plan)).toEqual([
      {
        command:
          'git config --global url."http://gitea.local/npm-mirrors/github.com-owner-repo.git".insteadOf "https://github.com/owner/repo"',
        insteadOf: 'https://github.com/owner/repo',
        targetUrl: 'http://gitea.local/npm-mirrors/github.com-owner-repo.git',
      },
      {
        command:
          'git config --global url."http://gitea.local/npm-mirrors/github.com-owner-repo.git".insteadOf "https://github.com/owner/repo.git"',
        insteadOf: 'https://github.com/owner/repo.git',
        targetUrl: 'http://gitea.local/npm-mirrors/github.com-owner-repo.git',
      },
    ]);
  });
});

describe('applyGitMirrors', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-git-apply-'));
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('plans pushes without running git in dry-run mode', async () => {
    const calls: GitCommandInvocation[] = [];
    const report = await applyGitMirrors({
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
    expect(report).toMatchObject({
      dryRun: true,
      errors: [],
      missingMirrors: 0,
      planned: 1,
      pushed: 0,
      totalRepositories: 1,
    });
  });

  it('reports missing local mirrors', async () => {
    const report = await applyGitMirrors({
      bundleDir,
      generatedAt: '2026-05-20T00:00:00.000Z',
      plan,
    });

    expect(report).toMatchObject({
      dryRun: false,
      errors: [
        {
          repository: 'github.com-owner-repo',
          sourcePath: path.join(bundleDir, 'git-mirrors/github.com-owner-repo.git'),
          status: 'missing-mirror',
          targetUrl: 'http://gitea.local/npm-mirrors/github.com-owner-repo.git',
        },
      ],
      missingMirrors: 1,
      pushed: 0,
    });
  });

  it('pushes existing local mirrors to the target URL', async () => {
    const sourcePath = path.join(bundleDir, 'git-mirrors/github.com-owner-repo.git');
    await fs.ensureDir(sourcePath);
    const calls: GitCommandInvocation[] = [];

    const report = await applyGitMirrors({
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
          sourcePath,
          'push',
          '--mirror',
          'http://gitea.local/npm-mirrors/github.com-owner-repo.git',
        ],
      },
    ]);
    expect(report).toMatchObject({
      errors: [],
      missingMirrors: 0,
      planned: 0,
      pushed: 1,
      totalRepositories: 1,
    });
  });

  it('records push failures', async () => {
    const sourcePath = path.join(bundleDir, 'git-mirrors/github.com-owner-repo.git');
    await fs.ensureDir(sourcePath);

    const report = await applyGitMirrors({
      bundleDir,
      generatedAt: '2026-05-20T00:00:00.000Z',
      plan,
      runner: () => Promise.reject(new Error('push rejected')),
    });

    expect(report).toMatchObject({
      errors: [
        {
          error: 'push rejected',
          repository: 'github.com-owner-repo',
          sourcePath,
          status: 'error',
          targetUrl: 'http://gitea.local/npm-mirrors/github.com-owner-repo.git',
        },
      ],
      pushed: 0,
    });
  });
});
