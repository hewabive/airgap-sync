import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import type { PythonApplicationBundleIndex } from '../../src/core/python/application-bundle.js';
import { normalizePlatformCoveragePolicy } from '../../src/core/python/coverage-policy.js';
import { createPythonEnvironmentPlan } from '../../src/core/python/environment-plan.js';
import {
  materializePythonPublication,
  pythonPublicationManifestPath,
} from '../../src/core/python/publication-manifest.js';
import {
  normalizePythonPublicationProfile,
  resolvePythonPublicationProfile,
} from '../../src/core/python/publication-targets.js';

let bundleDir: string;

beforeEach(async () => {
  bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-publication-'));
});

afterEach(async () => {
  await fs.remove(bundleDir);
});

async function bundleFixture(): Promise<PythonApplicationBundleIndex> {
  const policy = normalizePlatformCoveragePolicy({
    id: 'windows',
    platforms: ['windows-x86_64'],
  });
  const plan = createPythonEnvironmentPlan({
    application: { name: 'demo', version: '1.0.0' },
    coverage: { digest: 'a'.repeat(64), families: [], policy },
    createdAt: '2026-07-28T00:00:00.000Z',
    intent: {
      application: { extras: [], features: {}, name: 'demo' },
      coverage: { policyId: 'windows' },
      python: { policy: 'auto' },
      source: { type: 'pypi' },
      updatePolicy: 'manual',
    },
    platforms: [
      {
        packages: [
          {
            dependencies: [],
            name: 'demo',
            version: '1.0.0',
            wheels: ['demo-1.0.0-py3-none-any.whl'],
          },
        ],
        platformFamilyId: 'windows-x86_64',
        pythonMinor: '3.11',
        rejectedReasons: [],
        requirementsLockPath: 'lock/windows-x86_64--py311.requirements.lock',
        requiresPython: '>=3.11,<3.12',
        status: 'supported',
      },
    ],
    resolver: { engine: 'uv', policyVersion: 1, version: '0.11.16' },
    schemaVersion: 2,
    wheels: [
      {
        filename: 'demo-1.0.0-py3-none-any.whl',
        package: 'demo',
        platforms: ['windows-x86_64'],
        sha256: 'd'.repeat(64),
        url: 'https://files.example/demo.whl',
        version: '1.0.0',
      },
    ],
  });
  const planPath = 'python/applications/demo--windows/environment-plan.json';
  const planDiffPath = 'python/applications/demo--windows/plan-diff.json';
  const prerequisiteReportPath = 'python/applications/demo--windows/prerequisites.json';
  await fs.writeJson(path.join(bundleDir, planPath), plan, { spaces: 2 });
  await fs.writeJson(
    path.join(bundleDir, planDiffPath),
    { planId: { to: plan.planId }, schemaVersion: 1 },
    { spaces: 2 }
  );
  await fs.writeJson(
    path.join(bundleDir, prerequisiteReportPath),
    {
      generatedAt: '2026-07-28T00:00:00.000Z',
      planId: plan.planId,
      schemaVersion: 1,
    },
    { spaces: 2 }
  );
  return {
    applications: [
      {
        application: plan.application,
        artifactIds: [],
        branchSizes: [],
        features: {},
        locks: [],
        planDiffPath,
        planId: plan.planId,
        planPath,
        prerequisiteReportPath,
        targetId: 'demo--windows',
      },
    ],
    artifacts: [],
    createdAt: '2026-07-28T00:00:00.000Z',
    schemaVersion: 2,
    summary: { applications: 1, artifacts: 0, totalBytes: 0 },
  };
}

describe('Python publication manifest', () => {
  it('materializes deterministic destination documents without changing plan identity', async () => {
    const index = await bundleFixture();
    const firstProfile = resolvePythonPublicationProfile(
      normalizePythonPublicationProfile({
        owner: {
          kind: 'organization',
          name: 'airgap-packages',
          strategy: 'fixed-owner',
        },
        visibility: 'public',
      }),
      'admin'
    );
    const first = await materializePythonPublication('http://gitea.local///', {
      bundleDir,
      index,
      profile: firstProfile,
    });
    const repeated = await materializePythonPublication('http://gitea.local', {
      bundleDir,
      index,
      profile: firstProfile,
    });

    expect(repeated).toEqual(first);
    expect(first.applications[0]).toMatchObject({
      genericPackage: {
        owner: 'airgap-packages',
        package: 'demo-windows',
      },
      planId: index.applications[0]?.planId,
      pypiIndexUrl: 'http://gitea.local/api/packages/airgap-packages/pypi/simple',
    });
    expect(first.applications[0]?.sourceDocuments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: index.applications[0]?.prerequisiteReportPath,
        }),
      ])
    );
    expect(first.schemaVersion).toBe(2);
    expect(first.applications[0]?.genericPackage.version).toContain(
      `pub.${first.publicationId.slice(0, 12)}`
    );
    expect(
      await fs.pathExists(path.join(bundleDir, pythonPublicationManifestPath(first.publicationId)))
    ).toBe(true);
    const contractPath = first.applications[0]!.documents.find((document) =>
      document.file.endsWith('/consumer-contract.json')
    )!.file;
    const contract = await fs.readFile(path.join(bundleDir, contractPath), 'utf8');
    expect(contract).toContain('http://gitea.local/api/packages/airgap-packages/pypi/simple');
    expect(contract).not.toContain('admin');
    expect(contract).not.toMatch(/token|password/iu);

    await fs.writeJson(
      path.join(bundleDir, index.applications[0]!.prerequisiteReportPath),
      {
        generatedAt: '2026-07-29T00:00:00.000Z',
        planId: index.applications[0]?.planId,
        schemaVersion: 1,
      },
      { spaces: 2 }
    );
    const changedSource = await materializePythonPublication('http://gitea.local', {
      bundleDir,
      index,
      profile: firstProfile,
    });
    expect(changedSource.publicationId).not.toBe(first.publicationId);
    expect(changedSource.applications[0]?.genericPackage.version).not.toBe(
      first.applications[0]?.genericPackage.version
    );

    const secondProfile = resolvePythonPublicationProfile(
      normalizePythonPublicationProfile({
        owner: {
          kind: 'organization',
          name: 'another-owner',
          strategy: 'fixed-owner',
        },
        visibility: 'public',
      }),
      'admin'
    );
    const second = await materializePythonPublication('http://gitea.local', {
      bundleDir,
      index,
      profile: secondProfile,
    });

    expect(second.publicationId).not.toBe(first.publicationId);
    expect(second.applications[0]?.planId).toBe(first.applications[0]?.planId);
  });
});
