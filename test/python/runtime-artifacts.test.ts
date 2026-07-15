import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import {
  transferPythonRuntimeArtifacts,
  verifyPythonRuntimeManifest,
} from '../../src/core/python/runtime-artifacts.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-python-runtime-'));
});

afterEach(async () => {
  await fs.remove(tempDir);
});

describe('Python runtime artifacts', () => {
  it('builds a uv-compatible release mirror and checksum manifest', async () => {
    const source = path.join(
      tempDir,
      'releases',
      'download',
      '20260623',
      'cpython-3.12.13-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'
    );
    const body = Buffer.from('portable python runtime fixture');
    await fs.ensureDir(path.dirname(source));
    await fs.writeFile(source, body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const bundleDir = path.join(tempDir, 'bundle');

    const manifest = await transferPythonRuntimeArtifacts({
      bundleDir,
      generatedAt: '2026-07-15T00:00:00.000Z',
      inputs: [
        {
          pythonVersion: '3.12.13',
          sha256,
          url: pathToFileURL(source).toString(),
        },
      ],
    });

    expect(manifest).toMatchObject({
      mirrorDirectory: 'python-runtime-mirror',
      runtimes: [
        {
          file: 'python-runtime-mirror/20260623/cpython-3.12.13-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz',
          pythonVersion: '3.12.13',
          sha256,
        },
      ],
    });
    expect(await verifyPythonRuntimeManifest(bundleDir, manifest!)).toEqual([]);

    await fs.writeFile(path.join(bundleDir, manifest!.runtimes[0]!.file), 'tampered');
    expect(await verifyPythonRuntimeManifest(bundleDir, manifest!)).toEqual([
      `Python runtime SHA-256 mismatch: ${manifest!.runtimes[0]!.file}`,
    ]);
  });
});
