import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyGitSources,
  createGitConfigRewriteRules,
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
        command: 'git config --global url."http://gitea.local/".insteadOf "https://github.com/"',
        insteadOf: 'https://github.com/',
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

    const report = await applyGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      runner: (invocation) => {
        calls.push(invocation);
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      {
        args: ['-C', sourcePath, 'push', '--mirror', 'http://gitea.local/owner/repo.git'],
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
    const sourcePath = path.join(bundleDir, 'git-mirrors/github.com/owner/repo.git');
    await fs.ensureDir(sourcePath);

    const report = await applyGitSources({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      manifest,
      runner: () => Promise.reject(new Error('push rejected')),
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
});
