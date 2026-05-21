import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectBundle } from '../src/core/collect.js';
import type { GitOutputCommandInvocation, GitOutputCommandResult } from '../src/core/repos.js';
import type { PackageMetadata } from '../src/types.js';

let tempDir: string;

const metadata: PackageMetadata = {
  name: 'demo',
  'dist-tags': {
    latest: '1.0.0',
  },
  versions: {
    '1.0.0': {
      name: 'demo',
      version: '1.0.0',
      dist: {
        tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
      },
    },
  },
};

describe('collectBundle', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-collect-'));
    await fs.ensureDir(path.join(tempDir, '.git'));
    await fs.writeJson(
      path.join(tempDir, 'package.json'),
      {
        name: 'root',
        version: '1.0.0',
        dependencies: {
          demo: 'latest',
          gitpkg: 'github:owner/repo#main',
        },
      },
      { spaces: 2 }
    );
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('updates repositories, resolves packages, creates git sources, and plans git fetches', async () => {
    const gitCalls: GitOutputCommandInvocation[] = [];
    const report = await collectBundle({
      dryRun: true,
      generatedAt: '2026-05-21T00:00:00.000Z',
      outputDir: path.join(tempDir, 'airgap-bundle'),
      registry: {
        getPackageMetadata(name) {
          expect(name).toBe('demo');
          return Promise.resolve(metadata);
        },
      },
      registryUrl: 'https://registry.example',
      root: tempDir,
      runGitOutputCommand(invocation): Promise<GitOutputCommandResult> {
        gitCalls.push(invocation);
        if (invocation.args.join(' ') === 'status --porcelain') {
          return Promise.resolve({ stderr: '', stdout: '' });
        }
        if (invocation.args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
          return Promise.resolve({ stderr: '', stdout: 'main\n' });
        }
        throw new Error(`Unexpected git call: ${invocation.args.join(' ')}`);
      },
    });

    expect(gitCalls).toEqual([
      {
        args: ['status', '--porcelain'],
        cwd: tempDir,
      },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        cwd: tempDir,
      },
    ]);
    expect(report).toMatchObject({
      dryRun: true,
      fetch: {
        downloaded: 0,
        errors: [],
        resolved: 1,
        skipped: 0,
      },
      gitFetch: {
        dryRun: true,
        errors: [],
        planned: 1,
        totalRepositories: 1,
      },
      repositoryUpdate: {
        errors: [],
        planned: 1,
        totalRepositories: 1,
      },
      wroteBundle: false,
    });
    expect(report.gitSources.sources).toEqual([
      {
        committish: 'main',
        host: 'github.com',
        id: 'github.com/owner/repo',
        localMirrorPath: 'git-mirrors/github.com/owner/repo.git',
        owner: 'owner',
        repo: 'repo',
        requirements: [
          {
            committish: 'main',
            hosted: {
              domain: 'github.com',
              project: 'repo',
              type: 'github',
              user: 'owner',
            },
            name: 'gitpkg',
            raw: 'gitpkg@github:owner/repo#main',
            rawSpec: 'github:owner/repo#main',
            requiredBy: 'root@1.0.0',
          },
        ],
        sourceUrl: 'https://github.com/owner/repo.git',
      },
    ]);
  });
});
