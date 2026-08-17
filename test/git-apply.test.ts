import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyGitSources,
  createGitConfigRewriteRules,
  type GitApplyProgressEvent,
  type GitCommandInvocation,
} from '../src/index.js';
import type { GitSourcesManifest } from '../src/types.js';

let bundleDir: string;

const manifest: GitSourcesManifest = {
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

describe('createGitConfigRewriteRules', () => {
  it('creates deterministic host-wide git config commands', () => {
    expect(createGitConfigRewriteRules(manifest, 'http://gitea.local/')).toEqual([
      {
        command: 'git config --global --add url."http://gitea.local/".insteadOf "git@github.com:"',
        insteadOf: 'git@github.com:',
        targetUrl: 'http://gitea.local/',
      },
      {
        command:
          'git config --global --add url."http://gitea.local/".insteadOf "https://github.com/"',
        insteadOf: 'https://github.com/',
        targetUrl: 'http://gitea.local/',
      },
      {
        command:
          'git config --global --add url."http://gitea.local/".insteadOf "ssh://git@github.com/"',
        insteadOf: 'ssh://git@github.com/',
        targetUrl: 'http://gitea.local/',
      },
    ]);
  });
});

describe('applyGitSources', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-git-apply-'));
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('plans pushes without running git in dry-run mode', async () => {
    const calls: GitCommandInvocation[] = [];
    const report = await applyGitSources({
      bundleDir,
      dryRun: true,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
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

  it('rejects destination collisions before planning or pushing', async () => {
    const calls: GitCommandInvocation[] = [];
    const collidingManifest: GitSourcesManifest = {
      ...manifest,
      sources: [
        manifest.sources[0]!,
        {
          ...manifest.sources[0]!,
          host: 'gitlab.example',
          id: 'gitlab.example/owner/repo',
          localMirrorPath: 'git-mirrors/gitlab.example/owner/repo.git',
          sourceUrl: 'https://gitlab.example/owner/repo.git',
        },
      ],
    };

    await expect(
      applyGitSources({
        bundleDir,
        dryRun: true,
        giteaBaseUrl: 'http://gitea.local',
        manifest: collidingManifest,
        runner: (invocation) => {
          calls.push(invocation);
          return Promise.resolve();
        },
      })
    ).rejects.toThrow(
      'Git publish target collision: owner/repo: github.com/owner/repo and gitlab.example/owner/repo'
    );
    expect(calls).toEqual([]);
  });

  it('reports missing local mirrors', async () => {
    const report = await applyGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
    });

    expect(report).toMatchObject({
      dryRun: false,
      errors: [
        {
          repository: 'github.com/owner/repo',
          sourcePath: path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git'),
          status: 'missing-mirror',
          targetUrl: 'http://gitea.local/owner/repo.git',
        },
      ],
      missingMirrors: 1,
      pushed: 0,
    });
  });

  it('pushes existing local mirrors to the target URL', async () => {
    const sourcePath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(sourcePath);
    const calls: GitCommandInvocation[] = [];
    const progress: GitApplyProgressEvent[] = [];

    const report = await applyGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      onProgress: (event) => progress.push(event),
      runner: (invocation) => {
        calls.push(invocation);
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      {
        args: [
          '-c',
          `safe.directory=${sourcePath}`,
          '-C',
          sourcePath,
          'push',
          '--prune',
          'http://gitea.local/owner/repo.git',
          '+refs/heads/*:refs/heads/*',
          '+refs/tags/*:refs/tags/*',
        ],
      },
    ]);
    expect(report).toMatchObject({
      actions: [
        {
          repository: 'github.com/owner/repo',
          sourcePath,
          status: 'pushed',
          targetUrl: 'http://gitea.local/owner/repo.git',
        },
      ],
      errors: [],
      missingMirrors: 0,
      planned: 0,
      pushed: 1,
      totalRepositories: 1,
    });
    expect(progress).toEqual([
      {
        current: 0,
        status: 'start',
        total: 1,
      },
      {
        current: 0,
        repository: 'github.com/owner/repo',
        status: 'progress',
        total: 1,
      },
      {
        action: {
          repository: 'github.com/owner/repo',
          sourcePath,
          status: 'pushed',
          targetUrl: 'http://gitea.local/owner/repo.git',
        },
        current: 1,
        repository: 'github.com/owner/repo',
        status: 'progress',
        total: 1,
      },
      {
        current: 1,
        status: 'done',
        total: 1,
      },
    ]);
  });

  it('synchronizes the Gitea default branch from the mirror HEAD after pushing', async () => {
    const sourcePath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(sourcePath);
    const calls: GitCommandInvocation[] = [];
    const defaultBranchCalls: unknown[] = [];
    const publishManifest: GitSourcesManifest = {
      ...manifest,
      sources: [
        {
          ...manifest.sources[0]!,
          publishOwner: 'mirrors',
          publishRepo: 'upstream-repo',
        },
      ],
    };

    const report = await applyGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      giteaClient: {
        setRepositoryDefaultBranch: (options) => {
          defaultBranchCalls.push(options);
          return Promise.resolve();
        },
      },
      manifest: publishManifest,
      runner: (invocation) => {
        calls.push(invocation);
        return Promise.resolve({
          stderr: '',
          stdout: invocation.args.includes('symbolic-ref') ? 'main\n' : '',
        });
      },
    });

    expect(calls).toEqual([
      {
        args: [
          '-c',
          `safe.directory=${sourcePath}`,
          '-C',
          sourcePath,
          'symbolic-ref',
          '--quiet',
          '--short',
          'HEAD',
        ],
      },
      {
        args: [
          '-c',
          `safe.directory=${sourcePath}`,
          '-C',
          sourcePath,
          'push',
          '--prune',
          'http://gitea.local/mirrors/upstream-repo.git',
          '+refs/heads/*:refs/heads/*',
          '+refs/tags/*:refs/tags/*',
        ],
      },
    ]);
    expect(defaultBranchCalls).toEqual([
      {
        branch: 'main',
        name: 'upstream-repo',
        owner: 'mirrors',
      },
    ]);
    expect(report).toMatchObject({
      actions: [
        {
          defaultBranch: 'main',
          repository: 'github.com/owner/repo',
          status: 'pushed',
        },
      ],
      errors: [],
      pushed: 1,
    });
  });

  it('reports a pushed repository when Gitea rejects its default branch update', async () => {
    const sourcePath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(sourcePath);

    const report = await applyGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      giteaClient: {
        setRepositoryDefaultBranch: () => Promise.reject(new Error('branch update rejected')),
      },
      manifest,
      runner: (invocation) =>
        Promise.resolve({
          stderr: '',
          stdout: invocation.args.includes('symbolic-ref') ? 'main\n' : '',
        }),
    });

    expect(report).toMatchObject({
      errors: [
        {
          defaultBranch: 'main',
          error:
            'pushed refs but failed to set Gitea default branch to main: branch update rejected',
          repository: 'github.com/owner/repo',
          status: 'error',
        },
      ],
      pushed: 0,
    });
  });

  it('passes Gitea token auth to Git push without changing report URLs', async () => {
    const sourcePath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(sourcePath);
    const calls: GitCommandInvocation[] = [];
    const authHeader = `Authorization: Basic ${Buffer.from('maxim:secret').toString('base64')}`;

    const report = await applyGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      gitAuth: {
        password: 'secret',
        username: 'maxim',
      },
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      runner: (invocation) => {
        calls.push(invocation);
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      {
        args: [
          '-c',
          `safe.directory=${sourcePath}`,
          '-c',
          'credential.helper=',
          '-c',
          `http.extraHeader=${authHeader}`,
          '-C',
          sourcePath,
          'push',
          '--prune',
          'http://gitea.local/owner/repo.git',
          '+refs/heads/*:refs/heads/*',
          '+refs/tags/*:refs/tags/*',
        ],
        env: {
          GCM_INTERACTIVE: 'never',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    ]);
    expect(report).toMatchObject({
      errors: [],
      pushed: 1,
    });
    expect(report.errors).toEqual([]);
  });

  it('records push failures', async () => {
    const sourcePath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(sourcePath);

    const report = await applyGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      runner: () => Promise.reject<undefined>(new Error('push rejected')),
    });

    expect(report).toMatchObject({
      errors: [
        {
          error: 'push rejected',
          repository: 'github.com/owner/repo',
          sourcePath,
          status: 'error',
          targetUrl: 'http://gitea.local/owner/repo.git',
        },
      ],
      pushed: 0,
    });
  });

  it('truncates large push failures in the report', async () => {
    const sourcePath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(sourcePath);
    const longError = Array.from(
      { length: 200 },
      (_, index) => `remote: error: hook declined to update refs/pull/${String(index)}/head`
    ).join('\n');

    const report = await applyGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      runner: () => Promise.reject<undefined>(new Error(longError)),
    });

    expect(report.errors[0]?.error).toContain('truncated 120 git output lines');
    expect(report.errors[0]?.error).toContain('refs/pull/0/head');
    expect(report.errors[0]?.error).toContain('refs/pull/199/head');
    expect(report.errors[0]?.error).not.toContain('refs/pull/100/head');
  });
});
