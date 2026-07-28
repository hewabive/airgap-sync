import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import { verifyInstall, type InstallCommandInvocation } from '../src/core/verify-install.js';
import type { GitCommandRunner } from '../src/core/git-fetch.js';
import type { GitSourcesManifest } from '../src/types.js';
import type { WorkspaceSnapshot } from '../src/core/workspace.js';
import type { PythonApplicationBundleIndex } from '../src/core/python/application-bundle.js';
import { normalizePlatformCoveragePolicy } from '../src/core/python/coverage-policy.js';
import { createPythonEnvironmentPlan } from '../src/core/python/environment-plan.js';

let workspaceDir: string;
let bundleDir: string;

const workspaceSnapshot: WorkspaceSnapshot = {
  createdAt: '2026-05-21T00:00:00.000Z',
  output: './bundle',
  schemaVersion: 1,
  sourceRegistry: 'https://registry.example',
  targets: [
    {
      localMirrorPath: 'git-mirrors/github.com/acme/app.git',
      sourceId: 'github.com/acme/app',
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

function gitRunnerWithProject(options: { lockfiles?: Record<string, string> }): GitCommandRunner {
  return async (invocation) => {
    expect(invocation.args.slice(0, 2)).toEqual([
      'clone',
      path.join(bundleDir, 'git-mirrors/github.com/acme/app.git'),
    ]);
    const checkoutPath = invocation.args.at(-1);
    if (!checkoutPath) {
      throw new Error('Missing checkout path');
    }
    await fs.ensureDir(checkoutPath);
    await fs.writeJson(
      path.join(checkoutPath, 'package.json'),
      {
        dependencies: {
          demo: 'latest',
        },
        name: 'app',
        version: '1.0.0',
      },
      { spaces: 2 }
    );
    for (const [fileName, content] of Object.entries(options.lockfiles ?? {})) {
      await fs.writeFile(path.join(checkoutPath, fileName), content);
    }
  };
}

describe('verifyInstall', () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-verify-install-'));
    bundleDir = path.join(workspaceDir, 'bundle');
    await fs.ensureDir(bundleDir);
    await fs.ensureDir(path.join(bundleDir, 'git-mirrors/github.com/acme/app.git'));
    await fs.writeJson(path.join(bundleDir, 'git-sources.json'), gitSources, { spaces: 2 });
  });

  afterEach(async () => {
    await fs.remove(workspaceDir);
  });

  it('runs npm ci in a temporary project copy with registry and Git rewrites', async () => {
    await writeWorkspaceSnapshot();
    const calls: InstallCommandInvocation[] = [];

    const report = await verifyInstall({
      bundleDir,
      generatedAt: '2026-05-21T00:01:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      gitRunner: gitRunnerWithProject({
        lockfiles: {
          'package-lock.json': JSON.stringify({
            lockfileVersion: 3,
            name: 'app',
            packages: {},
          }),
        },
      }),
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
    expect(calls[0]?.env.npm_config_cache).toContain('airgap-sync-install-');
    expect(calls[0]?.env.npm_config_registry).toBe('http://verdaccio.local:4873');
    expect(calls[0]?.env.npm_config_store_dir).toContain('airgap-sync-install-');
    expect(calls[0]?.env.YARN_CACHE_FOLDER).toContain('airgap-sync-install-');
    expect(calls[0]?.cwd).toContain('airgap-sync-install-');
    expect(report).toMatchObject({
      failed: 0,
      generatedAt: '2026-05-21T00:01:00.000Z',
      ignoreScripts: false,
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
    const calls: InstallCommandInvocation[] = [];

    await verifyInstall({
      bundleDir,
      giteaBaseUrl: 'http://gitea.local',
      gitRunner: gitRunnerWithProject({
        lockfiles: {
          'pnpm-lock.yaml': '',
        },
      }),
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
    expect(calls[0]?.env.npm_config_trust_lockfile).toBe('true');
    expect(calls[0]?.env.NPM_CONFIG_TRUST_LOCKFILE).toBe('true');
  });

  it('can skip package manager lifecycle scripts', async () => {
    await writeWorkspaceSnapshot();
    const calls: InstallCommandInvocation[] = [];

    const report = await verifyInstall({
      bundleDir,
      giteaBaseUrl: 'http://gitea.local',
      gitRunner: gitRunnerWithProject({
        lockfiles: {
          'package-lock.json': JSON.stringify({
            lockfileVersion: 3,
            name: 'app',
            packages: {},
          }),
        },
      }),
      ignoreScripts: true,
      registryUrl: 'http://verdaccio.local:4873',
      runner(invocation) {
        calls.push(invocation);
        return Promise.resolve({ exitCode: 0, stderr: '', stdout: '' });
      },
    });

    expect(calls[0]).toMatchObject({
      args: ['ci', '--ignore-scripts'],
      command: 'npm',
    });
    expect(report.ignoreScripts).toBe(true);
    expect(report.projects[0]).toMatchObject({
      command: ['npm', 'ci', '--ignore-scripts'],
      status: 'passed',
    });
  });

  it('skips projects without supported lockfiles', async () => {
    await writeWorkspaceSnapshot();

    const report = await verifyInstall({
      bundleDir,
      giteaBaseUrl: 'http://gitea.local',
      gitRunner: gitRunnerWithProject({}),
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

    const report = await verifyInstall({
      bundleDir,
      giteaBaseUrl: 'http://gitea.local',
      gitRunner: gitRunnerWithProject({
        lockfiles: {
          'package-lock.json': JSON.stringify({
            lockfileVersion: 3,
            name: 'app',
            packages: {},
          }),
        },
      }),
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

  it('creates a venv and verifies pinned wheels against the anonymous Gitea index', async () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      return;
    }
    await writeWorkspaceSnapshot({
      ...workspaceSnapshot,
      pythonPublishOwner: 'public',
      pythonTargetEnvironments: [
        {
          arch: 'x86_64',
          manylinux: 'manylinux_2_17',
          name: 'local',
          os: 'linux',
          pythonVersion: '3.11.9',
        },
      ],
      targets: [{ spec: 'demo==1.0', type: 'pypi' }],
    });
    await fs.writeJson(
      path.join(bundleDir, 'python-seed-manifest.json'),
      {
        schemaVersion: 1,
        createdAt: '2026-07-10T00:00:00.000Z',
        packages: [
          {
            files: [
              {
                environments: ['local'],
                file: 'python-packages/demo-1.0-py3-none-any.whl',
              },
            ],
            name: 'demo',
            version: '1.0',
          },
        ],
        roots: ['demo==1.0'],
        sourceIndex: 'https://pypi.org/simple/',
        targetEnvironments: [
          {
            arch: 'x86_64',
            manylinux: 'manylinux_2_17',
            name: 'local',
            os: 'linux',
            pythonVersion: '3.11.9',
          },
        ],
      },
      { spaces: 2 }
    );
    const calls: InstallCommandInvocation[] = [];
    const report = await verifyInstall({
      bundleDir,
      giteaBaseUrl: 'http://gitea.local',
      registryUrl: 'http://verdaccio.local:4873',
      runner(invocation) {
        calls.push(invocation);
        return Promise.resolve({
          exitCode: 0,
          stderr: invocation.args[0] === '--version' ? 'Python 3.11.9' : '',
          stdout: '',
        });
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ args: ['--version'], command: 'python3' });
    expect(calls[1]?.args.slice(0, 2)).toEqual(['-m', 'venv']);
    expect(calls[2]?.args).toEqual(
      expect.arrayContaining([
        'pip',
        'install',
        '--index-url',
        'http://gitea.local/api/packages/public/pypi/simple',
        '--no-deps',
        'demo==1.0',
      ])
    );
    expect(report.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ packageManager: 'pip', status: 'passed' })])
    );
  });

  it('verifies each matching Python application from its hash-complete lock', async () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      return;
    }
    const policy = normalizePlatformCoveragePolicy({
      id: 'linux-x64',
      platforms: ['linux-glibc-x86_64'],
    });
    const plan = createPythonEnvironmentPlan({
      application: { name: 'demo', version: '1.0.0' },
      coverage: { digest: 'a'.repeat(64), families: [], policy },
      createdAt: '2026-07-27T00:00:00.000Z',
      intent: {
        application: { extras: [], features: {}, name: 'demo' },
        coverage: { policyId: policy.id },
        python: { policy: 'auto' },
        source: { type: 'pypi' },
        updatePolicy: 'manual',
      },
      platforms: [
        {
          packages: [],
          platformFamilyId: 'linux-glibc-x86_64',
          pylockPath: 'lock/linux-glibc-x86_64--py311.pylock.toml',
          pythonMinor: '3.11',
          rejectedReasons: [],
          requirementsLockPath: 'lock/linux-glibc-x86_64--py311.requirements.lock',
          requiresPython: '>=3.11,<3.12',
          status: 'supported',
        },
      ],
      resolver: { engine: 'uv', policyVersion: 1, version: '0.11.16' },
      schemaVersion: 2,
      verification: {
        healthChecks: [{ args: ['-c', 'import demo'], command: 'python' }],
      },
      wheels: [],
    });
    const applicationDirectory = path.join(bundleDir, 'python/applications/demo--linux-x64');
    const lockFile =
      'python/applications/demo--linux-x64/lock/linux-glibc-x86_64--py311.requirements.lock';
    await fs.writeJson(path.join(applicationDirectory, 'environment-plan.json'), plan, {
      spaces: 2,
    });
    await fs.ensureDir(path.dirname(path.join(bundleDir, lockFile)));
    await fs.writeFile(path.join(bundleDir, lockFile), '# exact lock\n');
    const index: PythonApplicationBundleIndex = {
      applications: [
        {
          application: plan.application,
          artifactIds: [],
          branchSizes: [],
          features: {},
          locks: [
            {
              digest: 'b'.repeat(64),
              file: lockFile,
              format: 'requirements',
              platformFamilyId: 'linux-glibc-x86_64',
              pythonMinor: '3.11',
            },
          ],
          planDiffPath: 'python/applications/demo--linux-x64/plan-diff.json',
          planId: plan.planId,
          planPath: 'python/applications/demo--linux-x64/environment-plan.json',
          prerequisiteReportPath: 'python/applications/demo--linux-x64/prerequisites.json',
          targetId: 'demo--linux-x64',
        },
      ],
      artifacts: [],
      createdAt: '2026-07-27T00:00:00.000Z',
      schemaVersion: 2,
      summary: { applications: 1, artifacts: 0, totalBytes: 0 },
    };
    await fs.writeJson(path.join(bundleDir, 'python/application-index.json'), index, {
      spaces: 2,
    });
    await writeWorkspaceSnapshot({
      createdAt: '2026-07-27T00:00:00.000Z',
      output: './bundle',
      python: {
        applicationArtifactOwner: 'python-apps',
        planner: { engine: 'uv', version: '0.11.16' },
        publishOwner: 'pypi',
        sourceIndex: 'https://pypi.org/simple/',
      },
      schemaVersion: 2,
      sourceRegistry: 'https://registry.example',
      targets: [],
    });
    const calls: InstallCommandInvocation[] = [];
    const report = await verifyInstall({
      bundleDir,
      giteaBaseUrl: 'http://gitea.local',
      registryUrl: 'http://verdaccio.local:4873',
      runner(invocation) {
        calls.push(invocation);
        return Promise.resolve({
          exitCode: 0,
          stderr: invocation.args.includes('--version') ? 'Python 3.11.9' : '',
          stdout: '',
        });
      },
    });

    expect(calls).toHaveLength(5);
    expect(calls[0]).toMatchObject({ args: ['--version'], command: 'python3.11' });
    expect(calls[2]?.args).toEqual(
      expect.arrayContaining([
        'install',
        '--only-binary=:all:',
        '--no-deps',
        '--require-hashes',
        '-r',
        path.join(bundleDir, lockFile),
      ])
    );
    expect(calls[3]).toMatchObject({ args: ['-m', 'pip', 'check'] });
    expect(calls[4]).toMatchObject({ args: ['-c', 'import demo'] });
    expect(report.projects).toEqual([
      expect.objectContaining({
        projectPath: 'python-app:demo--linux-x64',
        status: 'passed',
      }),
    ]);
  });
});
