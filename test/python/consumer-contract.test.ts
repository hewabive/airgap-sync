import { describe, expect, it } from 'vitest';
import {
  createPythonConsumerBundleDocuments,
  createPythonRequirementsLock,
} from '../../src/core/python/consumer-contract.js';
import { normalizePlatformCoveragePolicy } from '../../src/core/python/coverage-policy.js';
import { createPythonEnvironmentPlan } from '../../src/core/python/environment-plan.js';

function plan() {
  const policy = normalizePlatformCoveragePolicy({
    id: 'desktop-x64',
    platforms: ['windows-x86_64'],
  });
  return createPythonEnvironmentPlan({
    application: { name: 'demo', version: '1.0.0' },
    coverage: { digest: 'a'.repeat(64), families: [], policy },
    createdAt: '2026-07-27T00:00:00.000Z',
    intent: {
      application: { extras: [], features: {}, name: 'demo' },
      coverage: { policyId: policy.id },
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
            wheels: ['demo-1.0.0-cp311-cp311-win_amd64.whl', 'demo-1.0.0-py3-none-any.whl'],
          },
        ],
        platformFamilyId: 'windows-x86_64',
        pylockPath: 'lock/windows-x86_64--py311.pylock.toml',
        pythonMinor: '3.11',
        rejectedReasons: [],
        requirementsLockPath: 'lock/windows-x86_64--py311.requirements.lock',
        requiresPython: '>=3.11,<3.12',
        status: 'supported',
      },
    ],
    publication: {
      applicationArtifactOwner: 'python-apps',
      pythonPackageOwner: 'pypi',
    },
    resolver: { engine: 'uv', policyVersion: 1, version: '0.11.16' },
    schemaVersion: 1,
    verification: {
      healthChecks: [{ args: ['-c', 'import demo'], command: 'python' }],
    },
    wheels: [
      {
        filename: 'demo-1.0.0-cp311-cp311-win_amd64.whl',
        package: 'demo',
        platforms: ['windows-x86_64'],
        sha256: 'a'.repeat(64),
        size: 10,
        url: 'https://files.example/demo-win.whl',
        version: '1.0.0',
      },
      {
        filename: 'demo-1.0.0-py3-none-any.whl',
        package: 'demo',
        platforms: ['windows-x86_64'],
        sha256: 'b'.repeat(64),
        size: 11,
        url: 'https://files.example/demo-any.whl',
        version: '1.0.0',
      },
    ],
  });
}

describe('Python consumer contract', () => {
  it('generates one exact version with every accepted wheel hash', () => {
    const value = plan();
    const lock = createPythonRequirementsLock(value, value.platforms[0]!);

    expect(lock).toContain('demo==1.0.0');
    expect(lock).toContain(`--hash=sha256:${'a'.repeat(64)}`);
    expect(lock).toContain(`--hash=sha256:${'b'.repeat(64)}`);
    expect(lock).not.toContain('files.example');
    const firstHashLine = lock
      .split('\n')
      .find((line) => line.includes(`--hash=sha256:${'a'.repeat(64)}`));
    expect(firstHashLine?.endsWith('\\')).toBe(true);
    expect(firstHashLine?.endsWith('\\\\')).toBe(false);
  });

  it('generates pip and uv commands that use only the closed index and exact lock', () => {
    const documents = createPythonConsumerBundleDocuments(plan(), {
      giteaBaseUrl: 'http://gitea.local/',
    });

    expect(documents.contract).toMatchObject({
      configuration: {
        indexUrl: 'http://gitea.local/api/packages/pypi/pypi/simple',
      },
      installationOwner: 'consumer-infrastructure',
      publication: {
        owner: 'python-apps',
        package: 'demo-desktop-x64',
      },
    });
    expect(documents.contract.platforms[0]?.install.pip).toEqual(
      expect.arrayContaining([
        '--only-binary=:all:',
        '--no-deps',
        '--require-hashes',
        'lock/windows-x86_64--py311.requirements.lock',
      ])
    );
    expect(documents.contract.platforms[0]?.install.uv).toEqual(
      expect.arrayContaining([
        'sync',
        '--default-index',
        'http://gitea.local/api/packages/pypi/pypi/simple',
        '--require-hashes',
      ])
    );
    expect(documents.contract.platforms[0]?.healthChecks).toEqual([
      { args: ['-c', 'import demo'], command: 'python' },
    ]);
  });
});
