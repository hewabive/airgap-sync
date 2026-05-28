import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
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

function packageMetadata(name: string, versions: string[], latest: string): PackageMetadata {
  return {
    name,
    'dist-tags': {
      latest,
    },
    versions: Object.fromEntries(
      versions.map((version) => [
        version,
        {
          name,
          version,
          dist: {
            tarball: `https://registry.example/${name}/-/${name}-${version}.tgz`,
          },
        },
      ])
    ),
  };
}

function cleanRepositoryRunner(
  root: string
): (invocation: GitOutputCommandInvocation) => Promise<GitOutputCommandResult> {
  return (invocation) => {
    if (invocation.args.join(' ') === 'status --porcelain') {
      return Promise.resolve({ stderr: '', stdout: '' });
    }
    if (invocation.args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
      return Promise.resolve({ stderr: '', stdout: 'main\n' });
    }
    if (invocation.args.join(' ') === 'pull --ff-only') {
      return Promise.resolve({ stderr: '', stdout: 'Already up to date.\n' });
    }

    throw new Error(`Unexpected git call in ${root}: ${invocation.args.join(' ')}`);
  };
}

function gitCommand(invocation: { args: string[] }): string {
  const args =
    invocation.args[0] === '-c' && invocation.args[1]?.startsWith('safe.directory=')
      ? invocation.args.slice(2)
      : invocation.args;
  return args.join(' ');
}

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
    const progress: string[] = [];
    const report = await collectBundle({
      dryRun: true,
      generatedAt: '2026-05-21T00:00:00.000Z',
      onProgress(event) {
        progress.push(`${event.phase}:${event.status}`);
      },
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

    expect(progress).toContain('repository-update:start');
    expect(progress).toContain('repository-update:done');
    expect(progress).toContain('manifest-scan:done');
    expect(progress).toContain('npm-fetch:start');
    expect(progress).toContain('npm-fetch:done');
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
      async runGitCommand(invocation): Promise<undefined> {
        gitCalls.push(invocation);
        if (invocation.args[0] === 'init') {
          await fs.ensureDir(invocation.args.at(-1) ?? '');
        }
        return undefined;
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
        if (gitCommand(invocation) === 'rev-parse --verify main^{tree}') {
          return Promise.resolve({ stderr: '', stdout: 'tree\n' });
        }
        if (gitCommand(invocation) === 'ls-tree -r --name-only main') {
          return Promise.resolve({ stderr: '', stdout: 'package.json\n' });
        }
        if (gitCommand(invocation) === 'show main:package.json') {
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

    const mirrorPath = path.join(tempDir, 'airgap-bundle/git-mirrors/github.com/owner/repo.git');
    expect(gitCalls.map(gitCommand)).toEqual([
      `init --bare ${mirrorPath}`,
      `-C ${mirrorPath} remote add origin https://github.com/owner/repo.git`,
      `-C ${mirrorPath} config --replace-all remote.origin.fetch +refs/heads/*:refs/heads/*`,
      `-C ${mirrorPath} config --add remote.origin.fetch +refs/tags/*:refs/tags/*`,
      `-C ${mirrorPath} fetch --prune origin`,
      `-C ${mirrorPath} for-each-ref --format=%(refname) %(objectname) refs/heads refs/tags`,
      `-C ${mirrorPath} remote set-url origin https://github.com/owner/repo.git`,
      `-C ${mirrorPath} config --replace-all remote.origin.fetch +refs/heads/*:refs/heads/*`,
      `-C ${mirrorPath} config --add remote.origin.fetch +refs/tags/*:refs/tags/*`,
      `-C ${mirrorPath} fetch --prune origin`,
      `-C ${mirrorPath} for-each-ref --format=%(refname) %(objectname) refs/heads refs/tags`,
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
    expect(gitOutputCalls.map(gitCommand)).toEqual([
      'status --porcelain',
      'rev-parse --abbrev-ref HEAD',
      'pull --ff-only',
      'rev-parse --verify main^{tree}',
      'ls-tree -r --name-only main',
      'show main:package.json',
    ]);
  });

  it('runs workspace-style collection from initial Git sources without a repository root', async () => {
    const gitOutputCalls: GitOutputCommandInvocation[] = [];
    const gitCalls: GitCommandInvocation[] = [];

    const report = await collectBundle({
      generatedAt: '2026-05-21T00:00:00.000Z',
      initialGitSources: [
        {
          committish: 'main',
          host: 'github.com',
          id: 'github.com/acme/app',
          localMirrorPath: 'git-mirrors/github.com/acme/app.git',
          owner: 'acme',
          repo: 'app',
          requirements: [],
          sourceUrl: 'https://github.com/acme/app.git',
          target: true,
        },
      ],
      maxIterations: 5,
      outputDir: path.join(tempDir, 'airgap-bundle'),
      registry: {
        getPackageMetadata(name) {
          expect(name).toBe('demo');
          return Promise.resolve(metadata);
        },
      },
      registryUrl: 'https://registry.example',
      async runGitCommand(invocation): Promise<undefined> {
        gitCalls.push(invocation);
        if (invocation.args[0] === 'init') {
          await fs.ensureDir(invocation.args.at(-1) ?? '');
          return undefined;
        }
        return undefined;
      },
      runGitOutputCommand(invocation): Promise<GitOutputCommandResult> {
        gitOutputCalls.push(invocation);

        if (gitCommand(invocation) === 'rev-parse --verify main^{tree}') {
          return Promise.resolve({ stderr: '', stdout: 'tree\n' });
        }
        if (gitCommand(invocation) === 'ls-tree -r --name-only main') {
          return Promise.resolve({ stderr: '', stdout: 'package.json\n' });
        }
        if (gitCommand(invocation) === 'show main:package.json') {
          return Promise.resolve({
            stderr: '',
            stdout: JSON.stringify({
              dependencies: {
                demo: 'latest',
              },
              name: 'app',
              version: '1.0.0',
            }),
          });
        }

        throw new Error(`Unexpected git call: ${invocation.args.join(' ')}`);
      },
    });

    expect(report.repositoryUpdate).toMatchObject({
      totalRepositories: 0,
    });
    expect(report).toMatchObject({
      fixedPoint: true,
      fetch: {
        errors: [],
        resolved: 1,
      },
      iterations: [
        {
          addedRequirements: 1,
          gitSources: 1,
          iteration: 1,
          resolved: 0,
          scannedGitSources: 1,
        },
        {
          addedRequirements: 0,
          gitSources: 1,
          iteration: 2,
          resolved: 1,
          scannedGitSources: 0,
        },
      ],
      wroteBundle: true,
    });
    expect(gitCalls[0]).toEqual({
      args: [
        'init',
        '--bare',
        path.join(tempDir, 'airgap-bundle/git-mirrors/github.com/acme/app.git'),
      ],
    });
    expect(report.gitSources.sources[0]).toMatchObject({
      id: 'github.com/acme/app',
      target: true,
    });
    expect(gitOutputCalls.map(gitCommand)).toEqual([
      'rev-parse --verify main^{tree}',
      'ls-tree -r --name-only main',
      'show main:package.json',
    ]);
  });

  it('reports Git mirror changes from any fixed-point iteration', async () => {
    const outputDir = path.join(tempDir, 'airgap-bundle');
    const mirrorPath = path.join(outputDir, 'git-mirrors/github.com/acme/app.git');
    await fs.ensureDir(mirrorPath);
    const refFingerprints = [
      'refs/heads/main old\n',
      'refs/heads/main new\n',
      'refs/heads/main new\n',
      'refs/heads/main new\n',
    ];

    const report = await collectBundle({
      generatedAt: '2026-05-21T00:00:00.000Z',
      initialGitSources: [
        {
          committish: 'main',
          host: 'github.com',
          id: 'github.com/acme/app',
          localMirrorPath: 'git-mirrors/github.com/acme/app.git',
          owner: 'acme',
          repo: 'app',
          requirements: [],
          sourceUrl: 'https://github.com/acme/app.git',
          target: true,
        },
      ],
      maxIterations: 5,
      outputDir,
      registry: {
        getPackageMetadata(name) {
          expect(name).toBe('demo');
          return Promise.resolve(metadata);
        },
      },
      registryUrl: 'https://registry.example',
      runGitCommand(invocation) {
        if (invocation.args.includes('for-each-ref')) {
          return Promise.resolve({
            stderr: '',
            stdout: refFingerprints.shift() ?? 'refs/heads/main new\n',
          });
        }
        return Promise.resolve(undefined);
      },
      runGitOutputCommand(invocation): Promise<GitOutputCommandResult> {
        if (gitCommand(invocation) === 'rev-parse --verify main^{tree}') {
          return Promise.resolve({ stderr: '', stdout: 'tree\n' });
        }
        if (gitCommand(invocation) === 'ls-tree -r --name-only main') {
          return Promise.resolve({ stderr: '', stdout: 'package.json\n' });
        }
        if (gitCommand(invocation) === 'show main:package.json') {
          return Promise.resolve({
            stderr: '',
            stdout: JSON.stringify({
              dependencies: {
                demo: 'latest',
              },
              name: 'app',
              version: '1.0.0',
            }),
          });
        }

        throw new Error(`Unexpected git call: ${invocation.args.join(' ')}`);
      },
    });

    expect(report.iterations).toMatchObject([
      {
        addedRequirements: 1,
        iteration: 1,
      },
      {
        addedRequirements: 0,
        iteration: 2,
      },
    ]);
    expect(report.gitFetch).toMatchObject({
      changed: 1,
      cloned: 0,
      errors: [],
      totalRepositories: 1,
      unchanged: 0,
      updated: 1,
    });
    expect(report.gitFetch.actions).toEqual([
      expect.objectContaining({
        changed: true,
        repository: 'github.com/acme/app',
        status: 'updated',
      }),
    ]);
  });

  it('reuses previous tag resolutions from unchanged Git source manifests', async () => {
    const outputDir = path.join(tempDir, 'airgap-bundle');
    const mirrorPath = path.join(outputDir, 'git-mirrors/github.com/acme/app.git');
    await fs.ensureDir(path.join(outputDir, 'packages'));
    await fs.ensureDir(mirrorPath);
    await fs.writeFile(path.join(outputDir, 'packages/extra-1.0.0.tgz'), '');
    await fs.writeJson(path.join(outputDir, 'seed-manifest.json'), {
      schemaVersion: 1,
      createdAt: '2026-05-20T00:00:00.000Z',
      sourceRegistry: 'https://registry.example',
      packages: [
        {
          name: 'extra',
          version: '1.0.0',
          file: 'packages/extra-1.0.0.tgz',
          tarball: 'https://registry.example/extra/-/extra-1.0.0.tgz',
          resolvedFrom: [],
        },
      ],
    });
    await fs.writeJson(path.join(outputDir, 'dist-tags.json'), {
      schemaVersion: 1,
      createdAt: '2026-05-20T00:00:00.000Z',
      sourceRegistry: 'https://registry.example',
      tags: {
        extra: {
          latest: '1.0.0',
        },
      },
      requirements: [
        {
          name: 'extra',
          requiredBy: 'app@1.0.0',
          tag: 'latest',
          version: '1.0.0',
        },
      ],
    });

    const gitCalls: GitCommandInvocation[] = [];
    const report = await collectBundle({
      generatedAt: '2026-05-21T00:00:00.000Z',
      initialGitSources: [
        {
          committish: 'main',
          host: 'github.com',
          id: 'github.com/acme/app',
          localMirrorPath: 'git-mirrors/github.com/acme/app.git',
          owner: 'acme',
          repo: 'app',
          requirements: [],
          sourceUrl: 'https://github.com/acme/app.git',
          target: true,
        },
      ],
      maxIterations: 5,
      outputDir,
      registry: {
        getPackageMetadata(name) {
          expect(name).toBe('extra');
          return Promise.resolve(packageMetadata('extra', ['1.0.0', '2.0.0'], '2.0.0'));
        },
      },
      registryUrl: 'https://registry.example',
      runGitCommand(invocation) {
        gitCalls.push(invocation);
        if (invocation.args.includes('for-each-ref')) {
          return Promise.resolve({ stderr: '', stdout: 'refs/heads/main abc123\n' });
        }
        return Promise.resolve(undefined);
      },
      runGitOutputCommand(invocation): Promise<GitOutputCommandResult> {
        if (gitCommand(invocation) === 'rev-parse --verify main^{tree}') {
          return Promise.resolve({ stderr: '', stdout: 'tree\n' });
        }
        if (gitCommand(invocation) === 'ls-tree -r --name-only main') {
          return Promise.resolve({ stderr: '', stdout: 'package.json\n' });
        }
        if (gitCommand(invocation) === 'show main:package.json') {
          return Promise.resolve({
            stderr: '',
            stdout: JSON.stringify({
              dependencies: {
                extra: 'latest',
              },
              name: 'app',
              version: '1.0.0',
            }),
          });
        }

        throw new Error(`Unexpected git call: ${invocation.args.join(' ')}`);
      },
    });

    expect(report.gitFetch).toMatchObject({
      changed: 0,
      unchanged: 1,
      updated: 1,
    });
    expect(report.fetch).toMatchObject({
      errors: [],
      resolved: 1,
    });
    expect(
      tarballMocks.downloadResolvedPackage.mock.calls.map((call) => {
        const pkg = call[0] as ResolvedRootPackage;
        return `${pkg.name}@${pkg.version}`;
      })
    ).toEqual(['extra@1.0.0']);
    await expect(fs.readJson(path.join(outputDir, 'dist-tags.json'))).resolves.toMatchObject({
      tags: {
        extra: {
          latest: '1.0.0',
        },
      },
    });
    expect(gitCalls.map(gitCommand)).toEqual([
      `-C ${mirrorPath} for-each-ref --format=%(refname) %(objectname) refs/heads refs/tags`,
      `-C ${mirrorPath} remote set-url origin https://github.com/acme/app.git`,
      `-C ${mirrorPath} config --replace-all remote.origin.fetch +refs/heads/*:refs/heads/*`,
      `-C ${mirrorPath} config --add remote.origin.fetch +refs/tags/*:refs/tags/*`,
      `-C ${mirrorPath} fetch --prune origin`,
      `-C ${mirrorPath} for-each-ref --format=%(refname) %(objectname) refs/heads refs/tags`,
      `-C ${mirrorPath} for-each-ref --format=%(refname) %(objectname) refs/heads refs/tags`,
      `-C ${mirrorPath} remote set-url origin https://github.com/acme/app.git`,
      `-C ${mirrorPath} config --replace-all remote.origin.fetch +refs/heads/*:refs/heads/*`,
      `-C ${mirrorPath} config --add remote.origin.fetch +refs/tags/*:refs/tags/*`,
      `-C ${mirrorPath} fetch --prune origin`,
      `-C ${mirrorPath} for-each-ref --format=%(refname) %(objectname) refs/heads refs/tags`,
    ]);
  });

  it.each([
    {
      fileName: 'package-lock.json',
      lockfile: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/locked': { version: '1.0.0' },
        },
      }),
      label: 'npm package-lock',
    },
    {
      fileName: 'pnpm-lock.yaml',
      label: 'pnpm lockfile',
      lockfile: `
lockfileVersion: '9.0'
packages:
  locked@1.0.0: {}
`,
    },
    {
      fileName: 'yarn.lock',
      label: 'Yarn classic lockfile',
      lockfile: `
locked@^1.0.0:
  version "1.0.0"
  resolved "https://registry.yarnpkg.com/locked/-/locked-1.0.0.tgz"
`,
    },
    {
      fileName: 'yarn.lock',
      label: 'Yarn Berry lockfile',
      lockfile: `
__metadata:
  version: 8

"locked@npm:^1.0.0":
  version: 1.0.0
  resolution: "locked@npm:1.0.0"
`,
    },
  ])(
    'includes exact versions from $label while preserving latest tags',
    async ({ fileName, lockfile }) => {
      await fs.writeJson(
        path.join(tempDir, 'package.json'),
        {
          name: 'root',
          version: '1.0.0',
        },
        { spaces: 2 }
      );
      await fs.writeFile(path.join(tempDir, fileName), lockfile);

      const report = await collectBundle({
        generatedAt: '2026-05-21T00:00:00.000Z',
        latestPolicy: 'source',
        outputDir: path.join(tempDir, 'airgap-bundle'),
        registry: {
          getPackageMetadata(name) {
            expect(name).toBe('locked');
            return Promise.resolve(packageMetadata('locked', ['1.0.0', '1.1.0'], '1.1.0'));
          },
        },
        registryUrl: 'https://registry.example',
        root: tempDir,
        runGitOutputCommand: cleanRepositoryRunner(tempDir),
      });

      expect(report.fetch).toMatchObject({
        errors: [],
        resolved: 2,
      });
      expect(report.fixedPoint).toBe(true);
      expect(report.wroteBundle).toBe(true);
      expect(
        tarballMocks.downloadResolvedPackage.mock.calls.map((call) => {
          const pkg = call[0] as ResolvedRootPackage;
          return `${pkg.name}@${pkg.version}`;
        })
      ).toEqual(['locked@1.0.0', 'locked@1.1.0']);
    }
  );

  it('adds git dependencies found only in lockfiles to git sources', async () => {
    await fs.writeJson(
      path.join(tempDir, 'package.json'),
      {
        name: 'root',
        version: '1.0.0',
      },
      { spaces: 2 }
    );
    await fs.writeJson(
      path.join(tempDir, 'package-lock.json'),
      {
        lockfileVersion: 3,
        packages: {
          'node_modules/git-only': {
            resolved: 'git+https://github.com/acme/git-only.git#abc123',
            version: '1.0.0',
          },
        },
      },
      { spaces: 2 }
    );

    const report = await collectBundle({
      dryRun: true,
      generatedAt: '2026-05-21T00:00:00.000Z',
      outputDir: path.join(tempDir, 'airgap-bundle'),
      registry: {
        getPackageMetadata(name) {
          throw new Error(`Unexpected registry lookup for ${name}`);
        },
      },
      registryUrl: 'https://registry.example',
      root: tempDir,
      runGitOutputCommand: cleanRepositoryRunner(tempDir),
    });

    expect(report.fetch).toMatchObject({
      errors: [],
      resolved: 0,
    });
    expect(report.gitFetch).toMatchObject({
      dryRun: true,
      planned: 1,
      totalRepositories: 1,
    });
    expect(report.gitSources.sources).toEqual([
      {
        committish: 'abc123',
        fetchSpec: 'https://github.com/acme/git-only.git',
        host: 'github.com',
        id: 'github.com/acme/git-only',
        localMirrorPath: 'git-mirrors/github.com/acme/git-only.git',
        owner: 'acme',
        repo: 'git-only',
        requirements: [
          {
            committish: 'abc123',
            fetchSpec: 'https://github.com/acme/git-only.git',
            hosted: {
              domain: 'github.com',
              project: 'git-only',
              type: 'github',
              user: 'acme',
            },
            name: 'git-only',
            raw: 'git-only@git+https://github.com/acme/git-only.git#abc123',
            rawSpec: 'git+https://github.com/acme/git-only.git#abc123',
            requiredBy: 'lockfile:package-lock.json',
          },
        ],
        sourceUrl: 'https://github.com/acme/git-only.git',
      },
    ]);
  });

  it('includes explicit initial npm requirements', async () => {
    await fs.writeJson(
      path.join(tempDir, 'package.json'),
      {
        name: 'root',
        version: '1.0.0',
      },
      { spaces: 2 }
    );

    const report = await collectBundle({
      generatedAt: '2026-05-21T00:00:00.000Z',
      initialRequirements: [
        {
          name: 'extra',
          raw: 'extra@latest',
          requiredBy: 'root',
          specifier: 'latest',
          type: 'tag',
        },
      ],
      outputDir: path.join(tempDir, 'airgap-bundle'),
      registry: {
        getPackageMetadata(name) {
          expect(name).toBe('extra');
          return Promise.resolve(extraMetadata);
        },
      },
      registryUrl: 'https://registry.example',
      root: tempDir,
      runGitOutputCommand: cleanRepositoryRunner(tempDir),
    });

    expect(report.fetch).toMatchObject({
      errors: [],
      resolved: 1,
    });
    expect(report.wroteBundle).toBe(true);
    expect(
      tarballMocks.downloadResolvedPackage.mock.calls.map((call) => {
        const pkg = call[0] as ResolvedRootPackage;
        return `${pkg.name}@${pkg.version}`;
      })
    ).toEqual(['extra@1.0.0']);
  });
});
