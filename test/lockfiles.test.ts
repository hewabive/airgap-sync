import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { describe, expect, it } from 'vitest';
import {
  parseNpmLockRequirementsFromContent,
  parsePnpmLockRequirementsFromContent,
  parseYarnLockRequirementsFromContent,
  readLockfileRequirements,
} from '../src/core/lockfiles.js';

describe('parsePnpmLockRequirementsFromContent', () => {
  it('extracts exact package versions from pnpm lockfile package keys', () => {
    const result = parsePnpmLockRequirementsFromContent(
      `
lockfileVersion: '9.0'

packages:
  '@scope/demo@1.2.3':
    resolution: {integrity: sha512-demo}
  plain@2.0.0:
    resolution: {integrity: sha512-plain}

snapshots:
  '@scope/demo@1.2.3(peer@4.0.0)': {}
  linked@link:packages/linked: {}
`,
      'lockfile:pnpm-lock.yaml'
    );

    expect(result.requirements).toEqual([
      {
        name: '@scope/demo',
        raw: '@scope/demo@1.2.3',
        requiredBy: 'lockfile:pnpm-lock.yaml',
        specifier: '1.2.3',
        type: 'version',
      },
      {
        name: 'plain',
        raw: 'plain@2.0.0',
        requiredBy: 'lockfile:pnpm-lock.yaml',
        specifier: '2.0.0',
        type: 'version',
      },
    ]);
  });

  it('extracts git dependencies from pnpm importer entries', () => {
    const result = parsePnpmLockRequirementsFromContent(
      `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      '@antv/setup':
        specifier: github:antvis/G2#7cb42f57561c321ecb09b4552802ae0ac55b3a7a
        version: github.com/antvis/G2/7cb42f57561c321ecb09b4552802ae0ac55b3a7a
`,
      'lockfile:pnpm-lock.yaml'
    );

    expect(result.gitRequirements).toEqual([
      {
        committish: '7cb42f57561c321ecb09b4552802ae0ac55b3a7a',
        hosted: {
          domain: 'github.com',
          project: 'G2',
          type: 'github',
          user: 'antvis',
        },
        name: '@antv/setup',
        raw: '@antv/setup@github:antvis/G2#7cb42f57561c321ecb09b4552802ae0ac55b3a7a',
        rawSpec: 'github:antvis/G2#7cb42f57561c321ecb09b4552802ae0ac55b3a7a',
        requiredBy: 'lockfile:pnpm-lock.yaml',
      },
    ]);
  });
});

describe('parseNpmLockRequirementsFromContent', () => {
  it('extracts exact versions from npm package-lock v2/v3 packages', () => {
    const result = parseNpmLockRequirementsFromContent(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { version: '0.0.0' },
          'node_modules/@scope/demo': { version: '1.2.3' },
          'node_modules/plain': { version: '2.0.0' },
          'node_modules/local': { link: true, version: '1.0.0' },
          'node_modules/git-dep': {
            resolved: 'git+https://github.com/acme/git-dep.git',
            version: '1.0.0',
          },
        },
      }),
      'lockfile:package-lock.json'
    );

    expect(result.requirements).toEqual([
      {
        name: '@scope/demo',
        raw: '@scope/demo@1.2.3',
        requiredBy: 'lockfile:package-lock.json',
        specifier: '1.2.3',
        type: 'version',
      },
      {
        name: 'plain',
        raw: 'plain@2.0.0',
        requiredBy: 'lockfile:package-lock.json',
        specifier: '2.0.0',
        type: 'version',
      },
    ]);
    expect(result.gitRequirements).toEqual([
      {
        fetchSpec: 'https://github.com/acme/git-dep.git',
        hosted: {
          domain: 'github.com',
          project: 'git-dep',
          type: 'github',
          user: 'acme',
        },
        name: 'git-dep',
        raw: 'git-dep@git+https://github.com/acme/git-dep.git',
        rawSpec: 'git+https://github.com/acme/git-dep.git',
        requiredBy: 'lockfile:package-lock.json',
      },
    ]);
  });

  it('extracts exact versions from npm package-lock v1 dependencies', () => {
    const result = parseNpmLockRequirementsFromContent(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          parent: {
            version: '1.0.0',
            dependencies: {
              child: { version: '2.0.0' },
            },
          },
        },
      }),
      'lockfile:package-lock.json'
    );

    expect(result.requirements.map((requirement) => requirement.raw)).toEqual([
      'child@2.0.0',
      'parent@1.0.0',
    ]);
  });
});

describe('parseYarnLockRequirementsFromContent', () => {
  it('extracts exact versions from Yarn classic lockfiles', () => {
    const result = parseYarnLockRequirementsFromContent(
      `
"@scope/demo@^1.0.0":
  version "1.2.3"
  resolved "https://registry.yarnpkg.com/@scope/demo/-/demo-1.2.3.tgz"

plain@^2.0.0, plain@~2.0.0:
  version "2.0.1"
  resolved "https://registry.yarnpkg.com/plain/-/plain-2.0.1.tgz"
`,
      'lockfile:yarn.lock'
    );

    expect(result.requirements.map((requirement) => requirement.raw)).toEqual([
      '@scope/demo@1.2.3',
      'plain@2.0.1',
    ]);
  });

  it('extracts git dependencies from Yarn classic lockfiles', () => {
    const result = parseYarnLockRequirementsFromContent(
      `
"@antv/setup@git+https://github.com/antvis/G2.git#7cb42f57561c321ecb09b4552802ae0ac55b3a7a":
  version "7cb42f57561c321ecb09b4552802ae0ac55b3a7a"
  resolved "git+https://github.com/antvis/G2.git#7cb42f57561c321ecb09b4552802ae0ac55b3a7a"
`,
      'lockfile:yarn.lock'
    );

    expect(result.requirements).toEqual([]);
    expect(result.gitRequirements).toEqual([
      {
        committish: '7cb42f57561c321ecb09b4552802ae0ac55b3a7a',
        fetchSpec: 'https://github.com/antvis/G2.git',
        hosted: {
          domain: 'github.com',
          project: 'G2',
          type: 'github',
          user: 'antvis',
        },
        name: '@antv/setup',
        raw: '@antv/setup@git+https://github.com/antvis/G2.git#7cb42f57561c321ecb09b4552802ae0ac55b3a7a',
        rawSpec: 'git+https://github.com/antvis/G2.git#7cb42f57561c321ecb09b4552802ae0ac55b3a7a',
        requiredBy: 'lockfile:yarn.lock',
      },
    ]);
  });

  it('extracts exact versions from Yarn Berry lockfiles', () => {
    const result = parseYarnLockRequirementsFromContent(
      `
__metadata:
  version: 8

"@scope/demo@npm:^1.0.0":
  version: 1.2.3
  resolution: "@scope/demo@npm:1.2.3"

"plain@npm:^2.0.0":
  version: 2.0.1
  resolution: "plain@npm:2.0.1"
`,
      'lockfile:yarn.lock'
    );

    expect(result.requirements.map((requirement) => requirement.raw)).toEqual([
      '@scope/demo@1.2.3',
      'plain@2.0.1',
    ]);
  });

  it('extracts git dependencies from Yarn Berry lockfiles', () => {
    const result = parseYarnLockRequirementsFromContent(
      `
__metadata:
  version: 8

"@antv/setup@git+https://github.com/antvis/G2.git#commit=7cb42f57561c321ecb09b4552802ae0ac55b3a7a":
  version: 0.0.0-use.local
  resolution: "@antv/setup@git+https://github.com/antvis/G2.git#commit=7cb42f57561c321ecb09b4552802ae0ac55b3a7a"
`,
      'lockfile:yarn.lock'
    );

    expect(result.requirements).toEqual([]);
    expect(result.gitRequirements).toHaveLength(1);
    expect(result.gitRequirements[0]).toMatchObject({
      fetchSpec: 'https://github.com/antvis/G2.git',
      name: '@antv/setup',
      requiredBy: 'lockfile:yarn.lock',
    });
  });
});

describe('readLockfileRequirements', () => {
  it('reads supported lockfiles recursively and ignores generated directories', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-lockfiles-'));

    try {
      await fs.writeFile(
        path.join(tempDir, 'package-lock.json'),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            'node_modules/git-root': {
              resolved: 'git+https://github.com/acme/git-root.git#abc123',
              version: '1.0.0',
            },
            'node_modules/root-only': { version: '1.0.0' },
          },
        })
      );
      await fs.ensureDir(path.join(tempDir, 'packages/app'));
      await fs.writeFile(
        path.join(tempDir, 'packages/app/pnpm-lock.yaml'),
        `
lockfileVersion: '9.0'
packages:
  nested@2.0.0: {}
`
      );
      await fs.ensureDir(path.join(tempDir, 'node_modules/ignored'));
      await fs.writeFile(
        path.join(tempDir, 'node_modules/ignored/package-lock.json'),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            'node_modules/ignored': { version: '9.9.9' },
          },
        })
      );

      const result = await readLockfileRequirements(tempDir);

      expect(result.requirements.map((requirement) => requirement.raw)).toEqual([
        'nested@2.0.0',
        'root-only@1.0.0',
      ]);
      expect(result.gitRequirements.map((requirement) => requirement.raw)).toEqual([
        'git-root@git+https://github.com/acme/git-root.git#abc123',
      ]);
    } finally {
      await fs.remove(tempDir);
    }
  });
});
