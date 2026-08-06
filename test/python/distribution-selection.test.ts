import { describe, expect, it } from 'vitest';
import {
  selectCpythonDistributions,
  type CpythonDistributionCandidate,
  type WorkspaceCpythonDistributionsTarget,
} from '../../src/index.js';

function target(overrides: Partial<WorkspaceCpythonDistributionsTarget> = {}) {
  return {
    builds: { windowDays: 30 },
    patches: { latest: 1 },
    platforms: ['linux-glibc-x86_64', 'windows-x86_64'],
    provider: 'python-build-standalone',
    series: { from: '3.10', major: 3, through: 'latest-stable' },
    type: 'cpython-distributions',
    ...overrides,
  } satisfies WorkspaceCpythonDistributionsTarget;
}

function candidate(
  pythonVersion: string,
  platformFamilyId: CpythonDistributionCandidate['platformFamilyId'],
  providerBuild: string,
  providerPublishedAt: string,
  identity: string
): CpythonDistributionCandidate {
  const platform = platformFamilyId === 'linux-glibc-x86_64' ? 'linux' : 'windows';
  const filename = `cpython-${pythonVersion}+${providerBuild}-${platform}.tar.gz`;
  return {
    filename,
    platformFamilyId,
    provider: 'python-build-standalone',
    providerBuild,
    providerPublishedAt,
    pythonVersion,
    sha256: identity.repeat(64),
    size: 30_000_000,
    sourceUrl: `https://github.com/astral-sh/python-build-standalone/releases/download/${providerBuild}/${filename}`,
  };
}

describe('CPython distribution selection', () => {
  it('selects latest patch depth independently for every platform and expands new minors', () => {
    const candidates = [
      candidate('3.12.11', 'linux-glibc-x86_64', '20260728', '2026-07-28T10:00:00.000Z', 'a'),
      candidate('3.12.10', 'linux-glibc-x86_64', '20260501', '2026-05-01T10:00:00.000Z', 'b'),
      candidate('3.12.10', 'windows-x86_64', '20260501', '2026-05-01T10:00:00.000Z', 'c'),
      candidate('3.15.0', 'linux-glibc-x86_64', '20260805', '2026-08-05T10:00:00.000Z', 'd'),
      candidate('3.9.19', 'windows-x86_64', '20260805', '2026-08-05T10:00:00.000Z', 'e'),
    ];

    const result = selectCpythonDistributions({
      candidates,
      generatedAt: '2026-08-06T00:00:00.000Z',
      targets: [target()],
    });

    expect(
      result.artifacts.map((artifact) => [artifact.pythonVersion, artifact.platformFamilyId])
    ).toEqual([
      ['3.15.0', 'linux-glibc-x86_64'],
      ['3.12.11', 'linux-glibc-x86_64'],
      ['3.12.10', 'windows-x86_64'],
    ]);
  });

  it('keeps the newest build unconditionally and recent rebuilds inside the window', () => {
    const candidates = [
      candidate('3.12.11', 'linux-glibc-x86_64', '20260728', '2026-07-28T10:00:00.000Z', 'a'),
      candidate('3.12.11', 'linux-glibc-x86_64', '20260718', '2026-07-18T10:00:00.000Z', 'b'),
      candidate('3.12.11', 'linux-glibc-x86_64', '20260101', '2026-01-01T10:00:00.000Z', 'c'),
      candidate('3.11.9', 'windows-x86_64', '20250101', '2025-01-01T10:00:00.000Z', 'd'),
    ];

    const result = selectCpythonDistributions({
      candidates,
      generatedAt: '2026-08-06T00:00:00.000Z',
      targets: [target({ patches: { latest: 2 } })],
    });

    expect(result.artifacts.map((artifact) => artifact.providerBuild)).toEqual([
      '20260728',
      '20260718',
      '20250101',
    ]);
  });

  it('deduplicates shared artifacts while retaining target references', () => {
    const shared = candidate(
      '3.12.11',
      'linux-glibc-x86_64',
      '20260728',
      '2026-07-28T10:00:00.000Z',
      'a'
    );
    const result = selectCpythonDistributions({
      candidates: [shared],
      generatedAt: '2026-08-06T00:00:00.000Z',
      targets: [target(), target({ builds: { windowDays: 365 } })],
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.references).toHaveLength(2);
    expect(result.targets).toHaveLength(2);
  });
});
