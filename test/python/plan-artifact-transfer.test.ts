import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import { createPythonEnvironmentPlan } from '../../src/core/python/environment-plan.js';
import {
  transferPythonPlanArtifacts,
  verifyPythonPlanArtifactManifest,
} from '../../src/core/python/plan-artifact-transfer.js';
import { normalizePlatformCoveragePolicy } from '../../src/core/python/coverage-policy.js';

let tempDir: string;

describe('optional Python plan artifact transfer', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-plan-artifacts-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('hash-verifies artifacts and produces publishable coordinates', async () => {
    const content = Buffer.from('managed runtime fixture');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const sourcePath = path.join(tempDir, 'cpython.tar.gz');
    await fs.writeFile(sourcePath, content);
    const policy = normalizePlatformCoveragePolicy({
      id: 'windows',
      platforms: ['windows-x86_64'],
    });
    const plan = createPythonEnvironmentPlan({
      application: {
        name: 'demo-app',
        version: '1.0.0',
      },
      coverage: {
        digest: 'a'.repeat(64),
        families: [],
        policy,
      },
      createdAt: '2026-07-27T00:00:00.000Z',
      intent: {
        application: {
          extras: [],
          features: {},
          name: 'demo-app',
        },
        coverage: {
          policyId: 'windows',
        },
        python: {
          policy: 'auto',
        },
        source: {
          type: 'pypi',
        },
        updatePolicy: 'manual',
      },
      platforms: [],
      resolver: {
        engine: 'uv',
        policyVersion: 1,
        version: '0.11.16',
      },
      runtimeArtifacts: [
        {
          filename: 'cpython.tar.gz',
          kind: 'cpython',
          license: {
            spdx: 'Python-2.0',
            url: 'https://docs.python.org/3/license.html',
          },
          platforms: ['windows-x86_64'],
          sha256,
          size: content.byteLength,
          sourceUrl: pathToFileURL(sourcePath).toString(),
          version: '3.11.15',
        },
      ],
      schemaVersion: 2,
      wheels: [],
    });
    const bundleDir = path.join(tempDir, 'bundle');

    const manifest = await transferPythonPlanArtifacts({
      bundleDir,
      generatedAt: '2026-07-27T00:00:00.000Z',
      plan,
    });

    expect(manifest?.artifacts[0]).toMatchObject({ status: 'downloaded' });
    expect(manifest?.artifacts[0]).not.toHaveProperty('publication');
    expect(await verifyPythonPlanArtifactManifest(bundleDir, manifest!)).toEqual([]);

    await fs.writeFile(path.join(bundleDir, manifest!.artifacts[0]!.file), 'corrupt');
    expect(await verifyPythonPlanArtifactManifest(bundleDir, manifest!)).toEqual([
      expect.stringContaining('SHA-256 mismatch'),
      expect.stringContaining('size mismatch'),
    ]);
  });

  it('reports optional transfers without downloading during dry-run', async () => {
    const basePlan = createPythonEnvironmentPlan({
      application: { name: 'demo', version: '1.0.0' },
      coverage: {
        digest: 'a'.repeat(64),
        families: [],
        policy: normalizePlatformCoveragePolicy({
          id: 'windows',
          platforms: ['windows-x86_64'],
        }),
      },
      createdAt: '2026-07-27T00:00:00.000Z',
      intent: {
        application: { extras: [], features: {}, name: 'demo' },
        coverage: { policyId: 'windows' },
        python: { policy: 'auto' },
        source: { type: 'pypi' },
        updatePolicy: 'manual',
      },
      platforms: [],
      resolver: { engine: 'uv', policyVersion: 1, version: '0.11.16' },
      runtimeArtifacts: [
        {
          filename: 'uv.tar.gz',
          kind: 'uv',
          license: {
            spdx: 'Apache-2.0 OR MIT',
            url: 'https://example.test/license',
          },
          platforms: ['windows-x86_64'],
          sha256: 'a'.repeat(64),
          sourceUrl: 'https://example.test/uv.tar.gz',
          version: '0.11.16',
        },
      ],
      schemaVersion: 2,
      wheels: [],
    });

    const manifest = await transferPythonPlanArtifacts({
      bundleDir: path.join(tempDir, 'dry-run'),
      dryRun: true,
      plan: basePlan,
    });

    expect(manifest?.artifacts[0]?.status).toBe('would-download');
    expect(
      await fs.pathExists(path.join(tempDir, 'dry-run', 'python-plan-artifact-manifest.json'))
    ).toBe(false);
  });
});
