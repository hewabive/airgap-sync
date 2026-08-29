import type {
  FetchPackageAction,
  FetchReport,
  FetchTimings,
  GitFetchActionResult,
  GitFetchReport,
  ResolutionWarning,
  VulnerabilityResolutionAction,
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

function mergeOptionalCounts(previous?: number, next?: number): number | undefined {
  if (previous === undefined) {
    return next;
  }
  if (next === undefined) {
    return previous;
  }
  return previous + next;
}

function mergeGitFetchAction(
  previous: GitFetchActionResult,
  next: GitFetchActionResult
): GitFetchActionResult {
  const changed = mergeGitFetchChanged(previous.changed, next.changed);
  const addedRefs = mergeOptionalCounts(previous.addedRefs, next.addedRefs);
  const deletedRefs = mergeOptionalCounts(previous.deletedRefs, next.deletedRefs);
  const newCommits = mergeOptionalCounts(previous.newCommits, next.newCommits);
  const updatedRefs = mergeOptionalCounts(previous.updatedRefs, next.updatedRefs);
  const attempts = [...(previous.attempts ?? []), ...(next.attempts ?? [])];
  return {
    ...(addedRefs === undefined ? {} : { addedRefs }),
    ...(attempts.length === 0 ? {} : { attempts }),
    ...(deletedRefs === undefined ? {} : { deletedRefs }),
    ...((next.error ?? previous.error) ? { error: next.error ?? previous.error } : {}),
    ...(newCommits === undefined ? {} : { newCommits }),
    repository: next.repository,
    sourceUrl: next.sourceUrl,
    status: mergeGitFetchStatus(previous.status, next.status),
    targetPath: next.targetPath,
    ...(changed === undefined ? {} : { changed }),
    ...(updatedRefs === undefined ? {} : { updatedRefs }),
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

function vulnerabilityResolutionKey(action: VulnerabilityResolutionAction): string {
  return [action.name, action.requiredBy, action.specifier].join('\0');
}

function uniqueVulnerabilityResolutions(
  actions: VulnerabilityResolutionAction[]
): VulnerabilityResolutionAction[] {
  const byKey = new Map<string, VulnerabilityResolutionAction>();
  for (const action of actions) {
    byKey.set(vulnerabilityResolutionKey(action), action);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.requiredBy.localeCompare(right.requiredBy) ||
      left.specifier.localeCompare(right.specifier)
  );
}

function resolutionWarningKey(warning: ResolutionWarning): string {
  return [
    warning.code,
    warning.requiredBy,
    warning.name,
    warning.version,
    warning.specifier,
    warning.type,
  ].join('\0');
}

function uniqueResolutionWarnings(warnings: ResolutionWarning[]): ResolutionWarning[] {
  const byKey = new Map<string, ResolutionWarning>();
  for (const warning of warnings) {
    byKey.set(resolutionWarningKey(warning), warning);
  }
  return [...byKey.values()].sort((left, right) =>
    resolutionWarningKey(left).localeCompare(resolutionWarningKey(right))
  );
}

function sumFetchTimings(reports: FetchReport[]): FetchTimings {
  return reports.reduce<FetchTimings>(
    (total, report) => ({
      dependencyScanMs: total.dependencyScanMs + report.timings.dependencyScanMs,
      downloadMs: total.downloadMs + report.timings.downloadMs,
      metadataCacheHits: (total.metadataCacheHits ?? 0) + (report.timings.metadataCacheHits ?? 0),
      metadataCacheMemoryWrites:
        (total.metadataCacheMemoryWrites ?? 0) +
        (report.timings.metadataCacheMemoryWrites ?? report.timings.metadataCacheWrites ?? 0),
      metadataCachePersisted:
        (total.metadataCachePersisted ?? false) || (report.timings.metadataCachePersisted ?? false),
      metadataCacheWrites:
        (total.metadataCacheWrites ?? 0) + (report.timings.metadataCacheWrites ?? 0),
      manifestReadMs: total.manifestReadMs + report.timings.manifestReadMs,
      resolveMs: total.resolveMs + report.timings.resolveMs,
      resolveWorkerMs:
        (total.resolveWorkerMs ?? 0) + (report.timings.resolveWorkerMs ?? report.timings.resolveMs),
      ...((total.tarballCacheHits ?? 0) + (report.timings.tarballCacheHits ?? 0) > 0
        ? {
            tarballCacheHits:
              (total.tarballCacheHits ?? 0) + (report.timings.tarballCacheHits ?? 0),
          }
        : {}),
      ...((total.tarballCacheWrites ?? 0) + (report.timings.tarballCacheWrites ?? 0) > 0
        ? {
            tarballCacheWrites:
              (total.tarballCacheWrites ?? 0) + (report.timings.tarballCacheWrites ?? 0),
          }
        : {}),
      totalMs: total.totalMs + report.timings.totalMs,
    }),
    {
      dependencyScanMs: 0,
      downloadMs: 0,
      metadataCacheHits: 0,
      metadataCacheMemoryWrites: 0,
      metadataCachePersisted: false,
      metadataCacheWrites: 0,
      manifestReadMs: 0,
      resolveMs: 0,
      resolveWorkerMs: 0,
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
  const vulnerabilityResolutions = uniqueVulnerabilityResolutions(
    reports.flatMap((report) => report.vulnerabilityResolutions ?? [])
  );
  const warnings = uniqueResolutionWarnings(reports.flatMap((report) => report.warnings ?? []));

  return {
    ...last,
    downloaded: downloadedPackages.length,
    downloadedPackages,
    skipped:
      wouldDownloadPackages.length > 0
        ? last.skipped
        : Math.max(0, last.resolved - downloadedPackages.length),
    timings: sumFetchTimings(reports),
    ...(vulnerabilityResolutions.length > 0 ? { vulnerabilityResolutions } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    wouldDownloadPackages,
  };
}
