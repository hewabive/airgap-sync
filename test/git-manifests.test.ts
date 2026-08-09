import { describe, expect, it } from 'vitest';
import { readGitSourceManifestRequirements } from '../src/core/git-manifests.js';
import type { GitOutputCommandInvocation, GitOutputCommandResult } from '../src/core/repos.js';
import type { GitSource } from '../src/types.js';

const source: GitSource = {
  committish: 'main',
  host: 'github.com',
  id: 'github.com/owner/repo',
  localMirrorPath: 'git-mirrors/github.com/owner/repo.git',
  owner: 'owner',
  repo: 'repo',
  requirements: [],
  sourceUrl: 'https://github.com/owner/repo.git',
};

function gitCommand(invocation: GitOutputCommandInvocation): string {
  const args =
    invocation.args[0] === '-c' && invocation.args[1]?.startsWith('safe.directory=')
      ? invocation.args.slice(2)
      : invocation.args;
  return args.join(' ');
}

function safeMirrorArgs(mirrorPath: string, args: string[]): string[] {
  return ['-c', `safe.directory=${mirrorPath}`, ...args];
}

describe('readGitSourceManifestRequirements', () => {
  it('reads package manifests from a bare mirror revision', async () => {
    const calls: GitOutputCommandInvocation[] = [];

    const result = await readGitSourceManifestRequirements({
      includeDev: true,
      mirrorPath: '/bundle/git-mirrors/github.com/owner/repo.git',
      source,
      runner(invocation): Promise<GitOutputCommandResult> {
        calls.push(invocation);

        if (gitCommand(invocation) === 'rev-parse --verify main^{tree}') {
          return Promise.resolve({ stderr: '', stdout: 'tree\n' });
        }

        if (gitCommand(invocation) === 'ls-tree -r --name-only main') {
          return Promise.resolve({
            stderr: '',
            stdout: [
              'package.json',
              'packages/lib/package.json',
              'node_modules/ignored/package.json',
              'dist/ignored/package.json',
            ].join('\n'),
          });
        }

        if (gitCommand(invocation) === 'show main:package.json') {
          return Promise.resolve({
            stderr: '',
            stdout: JSON.stringify({
              name: 'root',
              version: '1.0.0',
              dependencies: {
                local: 'workspace:*',
                react: '^19.0.0',
              },
              devDependencies: {
                vitest: '^4.0.0',
              },
            }),
          });
        }

        if (gitCommand(invocation) === 'show main:packages/lib/package.json') {
          return Promise.resolve({
            stderr: '',
            stdout: JSON.stringify({
              name: 'local',
              version: '1.0.0',
              dependencies: {
                gitpkg: 'github:other/repo#main',
                zod: '^4.0.0',
              },
            }),
          });
        }

        throw new Error(`Unexpected git call: ${invocation.args.join(' ')}`);
      },
    });

    expect(calls).toEqual([
      {
        args: safeMirrorArgs('/bundle/git-mirrors/github.com/owner/repo.git', [
          'rev-parse',
          '--verify',
          'main^{tree}',
        ]),
        cwd: '/bundle/git-mirrors/github.com/owner/repo.git',
      },
      {
        args: safeMirrorArgs('/bundle/git-mirrors/github.com/owner/repo.git', [
          'ls-tree',
          '-r',
          '--name-only',
          'main',
        ]),
        cwd: '/bundle/git-mirrors/github.com/owner/repo.git',
      },
      {
        args: safeMirrorArgs('/bundle/git-mirrors/github.com/owner/repo.git', [
          'show',
          'main:package.json',
        ]),
        cwd: '/bundle/git-mirrors/github.com/owner/repo.git',
      },
      {
        args: safeMirrorArgs('/bundle/git-mirrors/github.com/owner/repo.git', [
          'show',
          'main:packages/lib/package.json',
        ]),
        cwd: '/bundle/git-mirrors/github.com/owner/repo.git',
      },
    ]);
    expect(result.manifestPaths).toEqual(['package.json', 'packages/lib/package.json']);
    expect(result.requirements).toEqual([
      {
        name: 'react',
        raw: 'react@^19.0.0',
        requiredBy: 'root@1.0.0',
        specifier: '^19.0.0',
        type: 'range',
      },
      {
        name: 'vitest',
        raw: 'vitest@^4.0.0',
        requiredBy: 'root@1.0.0',
        specifier: '^4.0.0',
        type: 'range',
      },
      {
        name: 'zod',
        raw: 'zod@^4.0.0',
        requiredBy: 'local@1.0.0',
        specifier: '^4.0.0',
        type: 'range',
      },
    ]);
    expect(result.gitRequirements).toEqual([
      {
        committish: 'main',
        hosted: {
          domain: 'github.com',
          project: 'repo',
          type: 'github',
          user: 'other',
        },
        name: 'gitpkg',
        raw: 'gitpkg@github:other/repo#main',
        rawSpec: 'github:other/repo#main',
        requiredBy: 'local@1.0.0',
      },
    ]);
    expect(result.unsupported).toEqual([]);
  });

  it('limits manifest discovery to gitSubdir when present', async () => {
    const result = await readGitSourceManifestRequirements({
      mirrorPath: '/bundle/git-mirrors/github.com/owner/repo.git',
      source: {
        ...source,
        gitSubdir: 'packages/plugin',
      },
      runner(invocation): Promise<GitOutputCommandResult> {
        if (gitCommand(invocation) === 'rev-parse --verify main^{tree}') {
          return Promise.resolve({ stderr: '', stdout: 'tree\n' });
        }

        if (gitCommand(invocation) === 'ls-tree -r --name-only main') {
          return Promise.resolve({
            stderr: '',
            stdout: ['package.json', 'packages/plugin/package.json'].join('\n'),
          });
        }

        if (gitCommand(invocation) === 'show main:packages/plugin/package.json') {
          return Promise.resolve({
            stderr: '',
            stdout: JSON.stringify({
              name: 'plugin',
              dependencies: {
                lodash: '^4.17.21',
              },
            }),
          });
        }

        throw new Error(`Unexpected git call: ${invocation.args.join(' ')}`);
      },
    });

    expect(result.manifestPaths).toEqual(['packages/plugin/package.json']);
    expect(result.requirements).toEqual([
      {
        name: 'lodash',
        raw: 'lodash@^4.17.21',
        requiredBy: 'plugin',
        specifier: '^4.17.21',
        type: 'range',
      },
    ]);
  });

  it('reads lockfile package versions from a bare mirror revision', async () => {
    const result = await readGitSourceManifestRequirements({
      mirrorPath: '/bundle/git-mirrors/github.com/owner/repo.git',
      source,
      runner(invocation): Promise<GitOutputCommandResult> {
        if (gitCommand(invocation) === 'rev-parse --verify main^{tree}') {
          return Promise.resolve({ stderr: '', stdout: 'tree\n' });
        }

        if (gitCommand(invocation) === 'ls-tree -r --name-only main') {
          return Promise.resolve({
            stderr: '',
            stdout: [
              'tools/ui/package.json',
              'tools/ui/package-lock.json',
              'tools/ui/node_modules/ignored/package-lock.json',
            ].join('\n'),
          });
        }

        if (gitCommand(invocation) === 'show main:tools/ui/package-lock.json') {
          return Promise.resolve({
            stderr: '',
            stdout: JSON.stringify({
              lockfileVersion: 3,
              packages: {
                'node_modules/@ungap/structured-clone': {
                  resolved:
                    'https://registry.npmjs.org/@ungap/structured-clone/-/structured-clone-1.3.0.tgz',
                  version: '1.3.0',
                },
              },
            }),
          });
        }

        if (gitCommand(invocation) === 'show main:tools/ui/package.json') {
          return Promise.resolve({
            stderr: '',
            stdout: JSON.stringify({
              name: 'ui',
            }),
          });
        }

        throw new Error(`Unexpected git call: ${invocation.args.join(' ')}`);
      },
    });

    expect(result.lockfilePaths).toEqual(['tools/ui/package-lock.json']);
    expect(result.manifestPaths).toEqual([]);
    expect(result.requirements).toEqual([
      {
        name: '@ungap/structured-clone',
        raw: '@ungap/structured-clone@1.3.0',
        requiredBy: 'lockfile:tools/ui/package-lock.json',
        specifier: '1.3.0',
        type: 'version',
      },
    ]);
  });

  it('reads a pinned pnpm toolchain from a package.json covered by pnpm-lock.yaml', async () => {
    const result = await readGitSourceManifestRequirements({
      mirrorPath: '/bundle/git-mirrors/github.com/owner/repo.git',
      source,
      runner(invocation): Promise<GitOutputCommandResult> {
        if (gitCommand(invocation) === 'rev-parse --verify main^{tree}') {
          return Promise.resolve({ stderr: '', stdout: 'tree\n' });
        }

        if (gitCommand(invocation) === 'ls-tree -r --name-only main') {
          return Promise.resolve({
            stderr: '',
            stdout: ['package.json', 'pnpm-lock.yaml'].join('\n'),
          });
        }

        if (gitCommand(invocation) === 'show main:package.json') {
          return Promise.resolve({
            stderr: '',
            stdout: JSON.stringify({
              name: 'arriero',
              packageManager: 'pnpm@11.17.0',
              version: '0.1.0',
            }),
          });
        }

        if (gitCommand(invocation) === 'show main:pnpm-lock.yaml') {
          return Promise.resolve({
            stderr: '',
            stdout: "lockfileVersion: '9.0'\n",
          });
        }

        throw new Error(`Unexpected git call: ${invocation.args.join(' ')}`);
      },
    });

    expect(result.manifestPaths).toEqual([]);
    expect(result.lockfilePaths).toEqual(['pnpm-lock.yaml']);
    expect(result.requirements).toEqual([
      {
        name: 'pnpm',
        raw: 'pnpm@11.17.0',
        requiredBy: 'package-manager:arriero@0.1.0',
        specifier: '11.17.0',
        type: 'version',
      },
      {
        name: '@pnpm/exe',
        raw: '@pnpm/exe@11.17.0',
        requiredBy: 'package-manager:arriero@0.1.0',
        specifier: '11.17.0',
        type: 'version',
      },
    ]);
  });

  it('reports a clear error when the requested revision is missing', async () => {
    await expect(
      readGitSourceManifestRequirements({
        mirrorPath: '/bundle/git-mirrors/github.com/owner/repo.git',
        source: {
          ...source,
          committish: 'missing-sha',
        },
        runner(invocation): Promise<GitOutputCommandResult> {
          if (gitCommand(invocation) === 'rev-parse --verify missing-sha^{tree}') {
            return Promise.reject(new Error('fatal: Needed a single revision'));
          }

          throw new Error(`Unexpected git call: ${invocation.args.join(' ')}`);
        },
      })
    ).rejects.toThrow(
      'Git source github.com/owner/repo does not contain requested revision missing-sha'
    );
  });
});
