import { describe, expect, it } from 'vitest';
import { aggregateFetchReports, aggregateGitFetchReports } from '../src/core/report-aggregation.js';
import type { FetchPackageAction, FetchReport, GitFetchReport } from '../src/types.js';

function packageAction(overrides: Partial<FetchPackageAction>): FetchPackageAction {
  return {
    file: `packages/${overrides.name ?? 'demo'}-${overrides.version ?? '1.0.0'}.tgz`,
    name: 'demo',
    raw: 'demo@latest',
    requiredBy: 'root',
    resolvedVia: 'tag',
    specifier: 'latest',
    type: 'tag',
    version: '1.0.0',
    ...overrides,
  };
}

function fetchReport(overrides: Partial<FetchReport>): FetchReport {
  return {
    downloaded: 0,
    downloadedPackages: [],
    errors: [],
    generatedAt: '2026-05-21T00:00:00.000Z',
    gitRequirements: [],
    resolved: 0,
    skipped: 0,
    timings: {
      dependencyScanMs: 0,
      downloadMs: 0,
      manifestReadMs: 0,
      resolveMs: 0,
      totalMs: 0,
    },
    unsupported: [],
    wouldDownloadPackages: [],
    ...overrides,
  };
}

function gitFetchReport(overrides: Partial<GitFetchReport>): GitFetchReport {
  return {
    actions: [],
    changed: 0,
    cloned: 0,
    dryRun: false,
    errors: [],
    generatedAt: '2026-05-21T00:00:00.000Z',
    mirrorsDir: '/bundle/git-mirrors',
    planned: 0,
    totalRepositories: 0,
    unchanged: 0,
    updated: 0,
    ...overrides,
  };
}

describe('report aggregation', () => {
  it('preserves npm downloads from earlier iterations', () => {
    const report = aggregateFetchReports([
      fetchReport({
        downloaded: 1,
        downloadedPackages: [packageAction({ name: 'demo', version: '1.0.0' })],
        resolved: 1,
        timings: {
          dependencyScanMs: 1,
          downloadMs: 2,
          manifestReadMs: 3,
          resolveMs: 4,
          tarballCacheWrites: 1,
          totalMs: 5,
        },
      }),
      fetchReport({
        downloaded: 1,
        downloadedPackages: [packageAction({ name: 'extra', version: '1.0.0' })],
        resolved: 2,
        timings: {
          dependencyScanMs: 10,
          downloadMs: 20,
          metadataCacheHits: 1,
          metadataCacheWrites: 2,
          manifestReadMs: 30,
          resolveMs: 40,
          tarballCacheHits: 2,
          tarballCacheWrites: 3,
          totalMs: 50,
        },
      }),
    ]);

    expect(report).toMatchObject({
      downloaded: 2,
      resolved: 2,
      skipped: 0,
      timings: {
        dependencyScanMs: 11,
        downloadMs: 22,
        metadataCacheHits: 1,
        metadataCacheWrites: 2,
        manifestReadMs: 33,
        resolveMs: 44,
        tarballCacheHits: 2,
        tarballCacheWrites: 4,
        totalMs: 55,
      },
    });
    expect(report?.downloadedPackages.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'demo@1.0.0',
      'extra@1.0.0',
    ]);
  });

  it('preserves and deduplicates vulnerability resolution actions', () => {
    const first = {
      advisoryIds: ['GHSA-demo'],
      fromVersion: '1.2.0',
      name: 'demo',
      requiredBy: 'parent@1.0.0',
      specifier: '^1.0.0',
      toVersion: '1.1.0',
    };
    const report = aggregateFetchReports([
      fetchReport({ vulnerabilityResolutions: [first] }),
      fetchReport({ vulnerabilityResolutions: [first] }),
    ]);

    expect(report?.vulnerabilityResolutions).toEqual([first]);
  });

  it('preserves Git mirror changes from earlier iterations', () => {
    const report = aggregateGitFetchReports([
      gitFetchReport({
        actions: [
          {
            addedRefs: 0,
            changed: true,
            deletedRefs: 0,
            newCommits: 2,
            repository: 'github.com/acme/app',
            sourceUrl: 'https://github.com/acme/app.git',
            status: 'updated',
            targetPath: '/bundle/git-mirrors/github.com/acme/app.git',
            updatedRefs: 1,
          },
        ],
        changed: 1,
        totalRepositories: 1,
        updated: 1,
      }),
      gitFetchReport({
        actions: [
          {
            changed: false,
            repository: 'github.com/acme/app',
            sourceUrl: 'https://github.com/acme/app.git',
            status: 'updated',
            targetPath: '/bundle/git-mirrors/github.com/acme/app.git',
          },
        ],
        totalRepositories: 1,
        unchanged: 1,
        updated: 1,
      }),
    ]);

    expect(report).toMatchObject({
      changed: 1,
      cloned: 0,
      errors: [],
      totalRepositories: 1,
      unchanged: 0,
      updated: 1,
    });
    expect(report?.actions).toEqual([
      expect.objectContaining({
        changed: true,
        newCommits: 2,
        repository: 'github.com/acme/app',
        updatedRefs: 1,
      }),
    ]);
  });
});
