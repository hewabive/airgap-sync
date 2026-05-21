import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import { verifyInstall, type InstallCommandInvocation } from '../src/core/verify-install.js';
import type { GitSourcesManifest } from '../src/types.js';
import type { WorkspaceSnapshot } from '../src/core/workspace.js';

let workspaceDir: string;
let bundleDir: string;

const workspaceSnapshot: WorkspaceSnapshot = {
  createdAt: '2026-05-21T00:00:00.000Z',
  output: './bundle',
  reposDir: './repos',
  schemaVersion: 1,
  sourceRegistry: 'https://registry.example',
  targets: [
    {
      localPath: 'repos/github.com/acme/app',
      status: 'exists',
      type: 'git',
      url: 'https://github.com/acme/app.git',
    },
  ],
};

const gitSources: GitSourcesManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-21T00:00:00.000Z',
  skipped: [],
  sources: [
    {
      host: 'github.com',
      id: 'github.com/acme/lib',
      localMirrorPath: 'git-mirrors/github.com/acme/lib.git',
      owner: 'acme',
      repo: 'lib',
      requirements: [],
      sourceUrl: 'https://github.com/acme/lib.git',
    },
  ],
};

async function writeWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot = workspaceSnapshot
): Promise<void> {
  await fs.writeJson(path.join(bundleDir, 'workspace-snapshot.json'), snapshot, { spaces: 2 });
}

describe('verifyInstall', () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-verify-install-'));
    bundleDir = path.join(workspaceDir, 'bundle');
    await fs.ensureDir(bundleDir);
    await fs.ensureDir(path.join(workspaceDir, 'repos/github.com/acme/app'));
    await fs.writeJson(path.join(bundleDir, 'git-sources.json'), gitSources, { spaces: 2 });
    await fs.writeJson(
      path.join(workspaceDir, 'repos/github.com/acme/app/package.json'),
      {
        dependencies: {
          demo: 'latest',
        },
        name: 'app',
        version: '1.0.0',
      },
      { spaces: 2 }
    );
  });

  afterEach(async () => {
    await fs.remove(workspaceDir);
  });

  it('runs npm ci in a temporary project copy with registry and Git rewrites', async () => {
    await writeWorkspaceSnapshot();
    await fs.writeJson(path.join(workspaceDir, 'repos/github.com/acme/app/package-lock.json'), {
      lockfileVersion: 3,
      name: 'app',
      packages: {},
    });
    const calls: InstallCommandInvocation[] = [];

    const report = await verifyInstall({
      bundleDir,
      generatedAt: '2026-05-21T00:01:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      registryUrl: 'http://verdaccio.local:4873',
      async runner(invocation) {
        calls.push(invocation);
        expect(await fs.readFile(invocation.env.GIT_CONFIG_GLOBAL ?? '', 'utf8')).toContain(
          '[url "http://gitea.local/"]'
        );
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'installed',
        };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: ['ci'],
      command: 'npm',
    });
    expect(typeof calls[0]?.env.GIT_CONFIG_GLOBAL).toBe('string');
    expect(calls[0]?.env.npm_config_registry).toBe('http://verdaccio.local:4873');
    expect(calls[0]?.cwd).not.toBe(path.join(workspaceDir, 'repos/github.com/acme/app'));
    expect(report).toMatchObject({
      failed: 0,
      generatedAt: '2026-05-21T00:01:00.000Z',
      ok: true,
      passed: 1,
      skipped: 0,
      totalProjects: 1,
    });
    expect(report.projects[0]).toMatchObject({
      command: ['npm', 'ci'],
      packageManager: 'npm',
      status: 'passed',
    });
    expect(await fs.pathExists(path.join(bundleDir, 'verify-install-report.json'))).toBe(true);
  });

  it('selects pnpm for pnpm lockfiles', async () => {
    await writeWorkspaceSnapshot();
    await fs.writeFile(path.join(workspaceDir, 'repos/github.com/acme/app/pnpm-lock.yaml'), '');
    const calls: InstallCommandInvocation[] = [];

    await verifyInstall({
      bundleDir,
      giteaBaseUrl: 'http://gitea.local',
      registryUrl: 'http://verdaccio.local:4873',
      runner(invocation) {
        calls.push(invocation);
        return Promise.resolve({ exitCode: 0, stderr: '', stdout: '' });
      },
    });

    expect(calls[0]).toMatchObject({
      args: ['install', '--frozen-lockfile'],
      command: 'pnpm',
    });
  });

  it('skips projects without supported lockfiles', async () => {
    await writeWorkspaceSnapshot();

    const report = await verifyInstall({
      bundleDir,
      giteaBaseUrl: 'http://gitea.local',
      registryUrl: 'http://verdaccio.local:4873',
      runner() {
        throw new Error('install should not run');
      },
    });

    expect(report).toMatchObject({
      failed: 0,
      ok: true,
      passed: 0,
      skipped: 1,
    });
    expect(report.projects[0]).toMatchObject({
      reason: 'No supported lockfile found',
      status: 'skipped',
    });
  });

  it('fails when install exits with a non-zero code', async () => {
    await writeWorkspaceSnapshot();
    await fs.writeJson(path.join(workspaceDir, 'repos/github.com/acme/app/package-lock.json'), {
      lockfileVersion: 3,
      name: 'app',
      packages: {},
    });

    const report = await verifyInstall({
      bundleDir,
      giteaBaseUrl: 'http://gitea.local',
      registryUrl: 'http://verdaccio.local:4873',
      runner() {
        return Promise.resolve({
          exitCode: 1,
          stderr: 'missing dependency',
          stdout: '',
        });
      },
    });

    expect(report.ok).toBe(false);
    expect(report).toMatchObject({
      failed: 1,
      passed: 0,
      skipped: 0,
    });
    expect(report.projects[0]).toMatchObject({
      exitCode: 1,
      status: 'failed',
      stderr: 'missing dependency',
    });
  });
});
