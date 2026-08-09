import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readManifestRequirements } from '../src/core/manifests.js';

let tempDir: string;

async function writePackageJson(relativePath: string, manifest: unknown): Promise<void> {
  const filePath = path.join(tempDir, relativePath);
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, manifest, { spaces: 2 });
}

describe('readManifestRequirements', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-manifests-'));
    await writePackageJson('package.json', {
      name: '@repo/root',
      private: true,
      dependencies: {
        '@repo/lib': 'workspace:*',
        react: '^19.0.0',
      },
      devDependencies: {
        vitest: '^4.0.0',
      },
    });
    await writePackageJson('packages/lib/package.json', {
      name: '@repo/lib',
      version: '1.0.0',
      dependencies: {
        'left-pad': '^1.3.0',
      },
      devDependencies: {
        typescript: '^5.0.0',
      },
      peerDependencies: {
        '@types/react': '^19.0.0',
        zod: '^4.0.0',
      },
      peerDependenciesMeta: {
        '@types/react': {
          optional: true,
        },
      },
    });
    await writePackageJson('node_modules/ignored/package.json', {
      name: 'ignored',
      dependencies: {
        never: 'latest',
      },
    });
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('reads dependencies from nested package manifests and skips local workspace specs', async () => {
    const result = await readManifestRequirements(path.join(tempDir, 'package.json'));

    expect(result.unsupported).toEqual([]);
    expect(result.requirements).toEqual([
      {
        name: 'react',
        raw: 'react@^19.0.0',
        requiredBy: '@repo/root',
        specifier: '^19.0.0',
        type: 'range',
      },
      {
        name: 'left-pad',
        raw: 'left-pad@^1.3.0',
        requiredBy: '@repo/lib@1.0.0',
        specifier: '^1.3.0',
        type: 'range',
      },
    ]);
  });

  it('can include dev and peer dependencies from all discovered manifests', async () => {
    const result = await readManifestRequirements(tempDir, {
      includeDev: true,
      includePeer: true,
    });

    expect(result.requirements.map((requirement) => requirement.name)).toEqual([
      'react',
      'vitest',
      'left-pad',
      'typescript',
      'zod',
    ]);
  });

  it('can skip manifests covered by lockfiles', async () => {
    await fs.writeFile(path.join(tempDir, 'package-lock.json'), '{}');
    await fs.writeFile(path.join(tempDir, 'packages/lib/package-lock.json'), '{}');
    await writePackageJson('examples/standalone/package.json', {
      name: 'standalone',
      version: '1.0.0',
      dependencies: {
        lodash: '^4.17.21',
      },
    });

    const result = await readManifestRequirements(tempDir, {
      skipManifestsCoveredByLockfiles: true,
    });

    expect(result.requirements).toEqual([
      {
        name: 'lodash',
        raw: 'lodash@^4.17.21',
        requiredBy: 'standalone@1.0.0',
        specifier: '^4.17.21',
        type: 'range',
      },
    ]);
  });

  it('uses root pnpm importers to cover nested workspace manifests', async () => {
    await fs.writeFile(
      path.join(tempDir, 'pnpm-lock.yaml'),
      ["lockfileVersion: '9.0'", 'importers:', "  '.': {}", '  packages/lib: {}'].join('\n')
    );
    await writePackageJson('examples/standalone/package.json', {
      name: 'standalone',
      version: '1.0.0',
      dependencies: {
        lodash: '^4.17.21',
      },
    });

    const result = await readManifestRequirements(tempDir, {
      skipManifestsCoveredByLockfiles: true,
    });

    expect(result.requirements).toEqual([
      {
        name: 'lodash',
        raw: 'lodash@^4.17.21',
        requiredBy: 'standalone@1.0.0',
        specifier: '^4.17.21',
        type: 'range',
      },
    ]);
  });

  it('keeps pinned pnpm toolchain requirements when a manifest is covered by a lockfile', async () => {
    await writePackageJson('apps/arriero/package.json', {
      name: 'arriero',
      packageManager: 'pnpm@11.17.0+sha512.0123456789abcdef',
      dependencies: {
        hono: '^4.12.0',
      },
      version: '0.1.0',
    });
    await fs.writeFile(
      path.join(tempDir, 'apps/arriero/pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n"
    );

    const result = await readManifestRequirements(tempDir, {
      skipManifestsCoveredByLockfiles: true,
    });

    expect(
      result.requirements.filter((requirement) =>
        requirement.requiredBy.startsWith('package-manager:')
      )
    ).toEqual([
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
    expect(result.requirements.some((requirement) => requirement.name === 'hono')).toBe(false);
  });

  it('uses devEngines.packageManager when no pnpm lockfile pins the selected version', async () => {
    await writePackageJson('tools/unlocked/package.json', {
      devEngines: {
        packageManager: {
          name: 'pnpm',
          onFail: 'download',
          version: '>=11.0.0 <12',
        },
      },
      name: 'unlocked-tool',
    });

    const result = await readManifestRequirements(tempDir);

    expect(
      result.requirements
        .filter((requirement) => requirement.requiredBy === 'package-manager:unlocked-tool')
        .map((requirement) => `${requirement.name}@${requirement.specifier}`)
    ).toEqual(['pnpm@>=11.0.0 <12', '@pnpm/exe@>=11.0.0 <12']);
  });

  it('skips component package manifests that are not npm packages', async () => {
    await writePackageJson('components/sha256/package.json', {
      name: 'sha256',
      version: '0.0.2',
      repo: 'jb55/sha256.c',
      src: ['sha256.c', 'sha256.h'],
      dependencies: {
        'jb55/rotate-bits.h': '0.1.1',
      },
    });

    const result = await readManifestRequirements(tempDir);

    expect(result.unsupported).toEqual([]);
    expect(result.requirements.some((requirement) => requirement.raw.includes('jb55'))).toBe(false);
  });
});
