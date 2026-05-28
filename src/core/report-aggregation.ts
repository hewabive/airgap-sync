import type {
  FetchPackageAction,
  FetchReport,
  FetchTimings,
  GitFetchActionResult,
  GitFetchReport,
} from '../types.js';

function mergeGitFetchStatus(
  previous: GitFetchActionResult['status'],
  next: GitFetchActionResult['status']
): GitFetchActionResult['status'] {
  if (previous === 'error' || next === 'error') {
    return 'error';
  }
  if (previous === 'cloned' || next === 'cloned') {
    return 'cloned';
  }
  if (previous === 'updated' || next === 'updated') {
    return 'updated';
  }
  return 'planned';
}

function mergeGitFetchChanged(
  previous: GitFetchActionResult['changed'],
  next: GitFetchActionResult['changed']
): GitFetchActionResult['changed'] {
  if (previous === true || next === true) {
    return true;
  }
  if (previous === false && next === false) {
    return false;
  }
  return next ?? previous;
}

function mergeGitFetchAction(
  previous: GitFetchActionResult,
  next: GitFetchActionResult
): GitFetchActionResult {
  const changed = mergeGitFetchChanged(previous.changed, next.changed);
  return {
    ...((next.error ?? previous.error) ? { error: next.error ?? previous.error } : {}),
    repository: next.repository,
    sourceUrl: next.sourceUrl,
    status: mergeGitFetchStatus(previous.status, next.status),
    targetPath: next.targetPath,
    ...(changed === undefined ? {} : { changed }),
  };
}

export function aggregateGitFetchReports(reports: GitFetchReport[]): GitFetchReport | undefined {
  const last = reports.at(-1);
  if (!last) {
    return undefined;
  }

  const actionsByRepository = new Map<string, GitFetchActionResult>();
  for (const report of reports) {
    for (const action of report.actions) {
      const previous = actionsByRepository.get(action.repository);
      actionsByRepository.set(
        action.repository,
        previous ? mergeGitFetchAction(previous, action) : action
      );
    }
  }

  const actions = [...actionsByRepository.values()].sort((left, right) =>
    left.repository.localeCompare(right.repository)
  );
  const errors = actions.filter((action) => action.status === 'error');

  return {
    actions,
    changed: actions.filter((action) => action.changed === true).length,
    cloned: actions.filter((action) => action.status === 'cloned').length,
    dryRun: reports.every((report) => report.dryRun),
    errors,
    generatedAt: last.generatedAt,
    mirrorsDir: last.mirrorsDir,
    planned: actions.filter((action) => action.status === 'planned').length,
    totalRepositories: actions.length,
    unchanged: actions.filter((action) => action.changed === false).length,
    updated: actions.filter((action) => action.status === 'updated').length,
  };
}

function fetchActionKey(action: FetchPackageAction): string {
  return [
    action.requiredBy,
    action.name,
    action.version,
    action.specifier,
    action.type,
    action.raw,
  ].join('\0');
}

function uniqueFetchActions(actions: FetchPackageAction[]): FetchPackageAction[] {
  const byKey = new Map<string, FetchPackageAction>();
  for (const action of actions) {
    byKey.set(fetchActionKey(action), action);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.requiredBy.localeCompare(right.requiredBy) ||
      left.raw.localeCompare(right.raw)
  );
}

function sumFetchTimings(reports: FetchReport[]): FetchTimings {
  return reports.reduce<FetchTimings>(
    (total, report) => ({
      dependencyScanMs: total.dependencyScanMs + report.timings.dependencyScanMs,
      downloadMs: total.downloadMs + report.timings.downloadMs,
      metadataCacheHits: (total.metadataCacheHits ?? 0) + (report.timings.metadataCacheHits ?? 0),
      metadataCacheWrites:
        (total.metadataCacheWrites ?? 0) + (report.timings.metadataCacheWrites ?? 0),
      manifestReadMs: total.manifestReadMs + report.timings.manifestReadMs,
      resolveMs: total.resolveMs + report.timings.resolveMs,
      totalMs: total.totalMs + report.timings.totalMs,
    }),
    {
      dependencyScanMs: 0,
      downloadMs: 0,
      metadataCacheHits: 0,
      metadataCacheWrites: 0,
      manifestReadMs: 0,
      resolveMs: 0,
      totalMs: 0,
    }
  );
}

export function aggregateFetchReports(reports: FetchReport[]): FetchReport | undefined {
  const last = reports.at(-1);
  if (!last) {
    return undefined;
  }

  const downloadedPackages = uniqueFetchActions(
    reports.flatMap((report) => report.downloadedPackages)
  );
  const wouldDownloadPackages = uniqueFetchActions(
    reports.flatMap((report) => report.wouldDownloadPackages)
  );

  return {
    ...last,
    downloaded: downloadedPackages.length,
    downloadedPackages,
    skipped:
      wouldDownloadPackages.length > 0
        ? last.skipped
        : Math.max(0, last.resolved - downloadedPackages.length),
    timings: sumFetchTimings(reports),
    wouldDownloadPackages,
  };
}
