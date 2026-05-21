import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectBundle } from '../src/core/collect.js';
import type { GitCommandInvocation } from '../src/core/git-fetch.js';
import type { GitOutputCommandInvocation, GitOutputCommandResult } from '../src/core/repos.js';
import type { PackageManifest, PackageMetadata, ResolvedRootPackage } from '../src/types.js';

const tarballMocks = vi.hoisted(() => ({
  dependencySpecsFromManifest: vi.fn(),
  downloadResolvedPackage: vi.fn(),
  manifests: new Map<string, PackageManifest>(),
  readPackageManifest: vi.fn(),
}));

vi.mock('../src/core/tarball.js', () => ({
  dependencySpecsFromManifest: tarballMocks.dependencySpecsFromManifest,
  downloadResolvedPackage: tarballMocks.downloadResolvedPackage,
  readPackageManifest: tarballMocks.readPackageManifest,
}));

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

const extraMetadata: PackageMetadata = {
  name: 'extra',
  'dist-tags': {
    latest: '1.0.0',
  },
  versions: {
    '1.0.0': {
      name: 'extra',
      version: '1.0.0',
      dist: {
        tarball: 'https://registry.example/extra/-/extra-1.0.0.tgz',
      },
    },
  },
};

describe('collectBundle', () => {
  beforeEach(async () => {
    tarballMocks.manifests.clear();
    tarballMocks.downloadResolvedPackage.mockReset();
    tarballMocks.readPackageManifest.mockReset();
    tarballMocks.dependencySpecsFromManifest.mockReset();
    tarballMocks.downloadResolvedPackage.mockImplementation((pkg: ResolvedRootPackage) => {
      const filePath = `/virtual/${pkg.name}-${pkg.version}.tgz`;
      tarballMocks.manifests.set(filePath, { name: pkg.name, version: pkg.version });
      return {
        file: `packages/${pkg.name}-${pkg.version}.tgz`,
        name: pkg.name,
        path: filePath,
        skipped: false,
        version: pkg.version,
      };
    });
    tarballMocks.readPackageManifest.mockImplementation((filePath: string) => {
      const manifest = tarballMocks.manifests.get(filePath);
      if (!manifest) {
        throw new Error(`Missing manifest for ${filePath}`);
      }
      return manifest;
    });
    tarballMocks.dependencySpecsFromManifest.mockImplementation(
      (manifest: PackageManifest) => manifest.dependencies ?? {}
    );

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
      fixedPoint: false,
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
      iterations: [
        {
          addedGitRequirements: 0,
          addedRequirements: 0,
          addedUnsupported: 0,
          gitSources: 1,
          iteration: 1,
          resolved: 1,
          scannedGitSources: 0,
        },
      ],
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

  it('runs collect to a fixed point by scanning manifests from fetched git mirrors', async () => {
    const gitOutputCalls: GitOutputCommandInvocation[] = [];
    const gitCalls: GitCommandInvocation[] = [];

    const report = await collectBundle({
      generatedAt: '2026-05-21T00:00:00.000Z',
      maxIterations: 5,
      outputDir: path.join(tempDir, 'airgap-bundle'),
      registry: {
        getPackageMetadata(name) {
          if (name === 'demo') {
            return Promise.resolve(metadata);
          }
          expect(name).toBe('extra');
          return Promise.resolve(extraMetadata);
        },
      },
      registryUrl: 'https://registry.example',
      root: tempDir,
      async runGitCommand(invocation): Promise<void> {
        gitCalls.push(invocation);
        if (invocation.args[0] === 'clone') {
          await fs.ensureDir(invocation.args.at(-1) ?? '');
        }
      },
      runGitOutputCommand(invocation): Promise<GitOutputCommandResult> {
        gitOutputCalls.push(invocation);

        if (invocation.args.join(' ') === 'status --porcelain') {
          return Promise.resolve({ stderr: '', stdout: '' });
        }
        if (invocation.args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
          return Promise.resolve({ stderr: '', stdout: 'main\n' });
        }
        if (invocation.args.join(' ') === 'pull --ff-only') {
          return Promise.resolve({ stderr: '', stdout: 'Already up to date.\n' });
        }
        if (invocation.args.join(' ') === 'rev-parse --verify main^{tree}') {
          return Promise.resolve({ stderr: '', stdout: 'tree\n' });
        }
        if (invocation.args.join(' ') === 'ls-tree -r --name-only main') {
          return Promise.resolve({ stderr: '', stdout: 'package.json\n' });
        }
        if (invocation.args.join(' ') === 'show main:package.json') {
          return Promise.resolve({
            stderr: '',
            stdout: JSON.stringify({
              name: 'git-root',
              version: '1.0.0',
              dependencies: {
                extra: 'latest',
              },
            }),
          });
        }

        throw new Error(`Unexpected git call: ${invocation.args.join(' ')}`);
      },
    });

    expect(gitCalls).toEqual([
      {
        args: [
          'clone',
          '--mirror',
          'https://github.com/owner/repo.git',
          path.join(tempDir, 'airgap-bundle/git-mirrors/github.com/owner/repo.git'),
        ],
      },
      {
        args: [
          '-C',
          path.join(tempDir, 'airgap-bundle/git-mirrors/github.com/owner/repo.git'),
          'remote',
          'set-url',
          'origin',
          'https://github.com/owner/repo.git',
        ],
      },
      {
        args: [
          '-C',
          path.join(tempDir, 'airgap-bundle/git-mirrors/github.com/owner/repo.git'),
          'remote',
          'update',
          '--prune',
        ],
      },
    ]);
    expect(report).toMatchObject({
      dryRun: false,
      fetch: {
        errors: [],
        resolved: 2,
      },
      fixedPoint: true,
      gitManifestScanErrors: [],
      iterations: [
        {
          addedGitRequirements: 0,
          addedRequirements: 1,
          addedUnsupported: 0,
          gitSources: 1,
          iteration: 1,
          resolved: 1,
          scannedGitSources: 1,
        },
        {
          addedGitRequirements: 0,
          addedRequirements: 0,
          addedUnsupported: 0,
          gitSources: 1,
          iteration: 2,
          resolved: 2,
          scannedGitSources: 0,
        },
      ],
      maxIterationsReached: false,
      wroteBundle: true,
    });
    expect(report.gitSources.sources).toHaveLength(1);
    expect(gitOutputCalls.map((call) => call.args.join(' '))).toEqual([
      'status --porcelain',
      'rev-parse --abbrev-ref HEAD',
      'pull --ff-only',
      'rev-parse --verify main^{tree}',
      'ls-tree -r --name-only main',
      'show main:package.json',
    ]);
  });
});
