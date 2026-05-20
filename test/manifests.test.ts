import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-registry-seed-manifests-'));
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
        zod: '^4.0.0',
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
});
