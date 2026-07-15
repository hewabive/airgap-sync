import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import type { PythonIndexClient } from '../../src/core/python/index-client.js';
import { PythonMetadataCache } from '../../src/core/python/metadata.js';
import { resolvePython } from '../../src/core/python/resolver.js';
import {
  preparePythonRootWheels,
  RootWheelPythonIndex,
} from '../../src/core/python/root-wheels.js';
import { createStoredZip } from './zip-fixture.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-root-wheel-'));
});

afterEach(async () => {
  await fs.remove(tempDir);
});

describe('Python root wheels', () => {
  it('verifies the root hash, extracts METADATA, and overlays the dependency index', async () => {
    const body = createStoredZip([
      {
        data: Buffer.from(
          'Metadata-Version: 2.4\nName: vllm\nVersion: 0.24.0\nRequires-Dist: torch>=2\n'
        ),
        name: 'vllm-0.24.0.dist-info/METADATA',
      },
    ]);
    const source = path.join(tempDir, 'vllm-0.24.0-py3-none-any.whl');
    await fs.writeFile(source, body);
    const hash = createHash('sha256').update(body).digest('hex');
    const roots = await preparePythonRootWheels({
      bundleDir: path.join(tempDir, 'bundle'),
      inputs: [
        {
          line: 1,
          requiredBy: 'root',
          sha256: hash,
          sourcePath: 'workspace-wheel-targets',
          url: pathToFileURL(source).toString(),
        },
      ],
    });
    const delegate: PythonIndexClient = {
      sourceIndex: 'https://pypi.org/simple',
      getMetadata: () =>
        Promise.resolve({
          metadata: {
            metadataVersion: '2.4',
            name: 'torch',
            projectUrls: [],
            providesExtra: [],
            requiresDist: [],
            version: '2.7.0',
          },
          source: 'core-metadata',
        }),
      getProject: (name) =>
        Promise.resolve({
          apiVersion: '1.0',
          files: [
            {
              filename: 'torch-2.7.0-py3-none-any.whl',
              hashes: { sha256: 'b'.repeat(64) },
              url: 'https://files.example/torch-2.7.0-py3-none-any.whl',
            },
          ],
          name,
        }),
    };
    const index = new RootWheelPythonIndex(delegate, roots);
    const project = await index.getProject('vllm');
    const metadata = await index.getMetadata(project.files[0]!, new PythonMetadataCache());

    expect(roots[0]?.requirement.requirement.specifier).toBe('==0.24.0');
    expect(metadata.metadata.requiresDist).toEqual(['torch>=2']);
    const resolution = await resolvePython({
      allowApproximate: true,
      cache: new PythonMetadataCache(),
      environments: [
        {
          arch: 'x86_64',
          manylinux: 'manylinux_2_17',
          name: 'linux',
          os: 'linux',
          pythonVersion: '3.12.13',
        },
      ],
      index,
      requirements: [roots[0]!.requirement],
    });
    expect(resolution.errors).toEqual([]);
    expect(resolution.artifacts.map((artifact) => `${artifact.name}==${artifact.version}`)).toEqual([
      'torch==2.7.0',
      'vllm==0.24.0',
    ]);
    expect(
      await fs.pathExists(
        path.join(tempDir, 'bundle', 'python-packages', 'vllm-0.24.0-py3-none-any.whl')
      )
    ).toBe(true);
  });

  it('rejects a root wheel whose SHA-256 does not match', async () => {
    const source = path.join(tempDir, 'demo-1.0-py3-none-any.whl');
    await fs.writeFile(
      source,
      createStoredZip([
        {
          data: Buffer.from('Metadata-Version: 2.4\nName: demo\nVersion: 1.0\n'),
          name: 'demo-1.0.dist-info/METADATA',
        },
      ])
    );

    await expect(
      preparePythonRootWheels({
        bundleDir: path.join(tempDir, 'bundle'),
        inputs: [
          {
            line: 1,
            requiredBy: 'root',
            sha256: '0'.repeat(64),
            sourcePath: 'workspace-wheel-targets',
            url: pathToFileURL(source).toString(),
          },
        ],
      })
    ).rejects.toThrow('SHA-256 mismatch');
  });
});
