import path from 'node:path';
import * as fs from './fs.js';
import { readBundleManifest, readDistTagsManifest, writeVerifyReport } from './bundle.js';
import { validateBundle } from './validation.js';
import type {
  ApplyBundleReport,
  BundleManifest,
  CollectReport,
  DistTagsManifest,
  FetchReport,
  GitSourcesManifest,
  VerifyCheck,
  VerifyCheckStatus,
  VerifyReport,
} from '../types.js';
import type { WorkspaceSnapshot } from './workspace.js';

export interface VerifyBundleOptions {
  bundleDir: string;
  generatedAt?: string;
  writeReport?: boolean;
}

function check(
  name: string,
  status: VerifyCheckStatus,
  message: string,
  details?: unknown
): VerifyCheck {
  return {
    ...(details === undefined ? {} : { details }),
    message,
    name,
    status,
  };
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }

  return fs.readJson<T>(filePath);
}

async function safeReadManifests(bundleDir: string): Promise<{
  checks: VerifyCheck[];
  distTags?: DistTagsManifest;
  manifest?: BundleManifest;
}> {
  const checks: VerifyCheck[] = [];
  let manifest: BundleManifest | undefined;
  let distTags: DistTagsManifest | undefined;

  try {
    manifest = await readBundleManifest(bundleDir);
  } catch (error) {
    checks.push(
      check('seed-manifest', 'error', 'seed-manifest.json is missing or unreadable', {
        error: (error as Error).message,
      })
    );
  }

  try {
    distTags = await readDistTagsManifest(bundleDir);
  } catch (error) {
    checks.push(
      check('dist-tags', 'error', 'dist-tags.json is missing or unreadable', {
        error: (error as Error).message,
      })
    );
  }

  return { checks, ...(distTags ? { distTags } : {}), ...(manifest ? { manifest } : {}) };
}

function summarizeChecks(checks: VerifyCheck[]): VerifyReport['summary'] {
  return {
    errors: checks.filter((item) => item.status === 'error').length,
    ok: checks.filter((item) => item.status === 'ok').length,
    warnings: checks.filter((item) => item.status === 'warning').length,
  };
}

function mirrorPath(bundleDir: string, localMirrorPath: string): string {
  return path.isAbsolute(localMirrorPath) ? localMirrorPath : path.join(bundleDir, localMirrorPath);
}

async function verifyGitMirrors(
  bundleDir: string,
  gitSources: GitSourcesManifest | undefined
): Promise<VerifyCheck> {
  if (!gitSources) {
    return check('git-sources', 'warning', 'git-sources.json is missing');
  }

  if (gitSources.skipped.length > 0) {
    return check(
      'git-sources',
      'error',
      `${String(gitSources.skipped.length)} Git sources were skipped`,
      {
        skipped: gitSources.skipped,
      }
    );
  }

  const missing: string[] = [];
  for (const source of gitSources.sources) {
    const sourceMirrorPath = mirrorPath(bundleDir, source.localMirrorPath);
    if (!(await fs.pathExists(sourceMirrorPath))) {
      missing.push(source.localMirrorPath);
    }
  }

  if (missing.length > 0) {
    return check(
      'git-mirrors',
      'error',
      `${String(missing.length)}/${String(gitSources.sources.length)} Git mirrors are missing`,
      { missing }
    );
  }

  return check(
    'git-mirrors',
    'ok',
    `${String(gitSources.sources.length)}/${String(gitSources.sources.length)} Git mirrors are present`
  );
}

export async function verifyBundle(options: VerifyBundleOptions): Promise<VerifyReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const checks: VerifyCheck[] = [];
  const { checks: manifestChecks, distTags, manifest } = await safeReadManifests(bundleDir);
  checks.push(...manifestChecks);

  if (manifest && distTags) {
    const validation = await validateBundle(bundleDir, manifest, distTags);
    checks.push(
      validation.valid
        ? check(
            'bundle-manifest',
            'ok',
            `Bundle manifest is valid with ${String(manifest.packages.length)} packages`
          )
        : check('bundle-manifest', 'error', 'Bundle manifest validation failed', {
            issues: validation.issues,
          })
    );
    const missing = validation.issues.filter((issue) => issue.code === 'missing-tarball');
    checks.push(
      missing.length === 0
        ? check(
            'tarballs',
            'ok',
            `${String(manifest.packages.length)}/${String(manifest.packages.length)} tarballs are present`
          )
        : check(
            'tarballs',
            'error',
            `${String(missing.length)}/${String(manifest.packages.length)} tarballs are missing`,
            { issues: missing }
          )
    );
  }

  const fetchReport = await readOptionalJson<FetchReport>(
    path.join(bundleDir, 'fetch-report.json')
  );
  if (!fetchReport) {
    checks.push(check('fetch-report', 'error', 'fetch-report.json is missing'));
  } else if (fetchReport.errors.length > 0) {
    checks.push(
      check('fetch-report', 'error', `${String(fetchReport.errors.length)} fetch errors`, {
        errors: fetchReport.errors,
      })
    );
  } else {
    checks.push(check('fetch-report', 'ok', 'fetch-report.json has no errors'));
  }

  const workspaceSnapshot = await readOptionalJson<WorkspaceSnapshot>(
    path.join(bundleDir, 'workspace-snapshot.json')
  );
  checks.push(
    workspaceSnapshot
      ? check(
          'workspace-snapshot',
          'ok',
          `workspace-snapshot.json records ${String(workspaceSnapshot.targets.length)} targets`
        )
      : check(
          'workspace-snapshot',
          'warning',
          'workspace-snapshot.json is missing; install verification will be unavailable'
        )
  );

  const collectReport = await readOptionalJson<CollectReport>(
    path.join(bundleDir, 'collect-report.json')
  );
  if (!collectReport) {
    checks.push(check('collect-report', 'warning', 'collect-report.json is missing'));
  } else if (!collectReport.fixedPoint || !collectReport.wroteBundle) {
    checks.push(
      check('collect-report', 'error', 'collect did not finish as a fixed-point bundle', {
        fixedPoint: collectReport.fixedPoint,
        maxIterationsReached: collectReport.maxIterationsReached,
        wroteBundle: collectReport.wroteBundle,
      })
    );
  } else {
    checks.push(check('collect-report', 'ok', 'collect-report.json reached a fixed point'));
  }

  const gitSources = await readOptionalJson<GitSourcesManifest>(
    path.join(bundleDir, 'git-sources.json')
  );
  checks.push(await verifyGitMirrors(bundleDir, gitSources));

  const applyReport = await readOptionalJson<ApplyBundleReport>(
    path.join(bundleDir, 'apply-report.json')
  );
  if (!applyReport) {
    checks.push(check('apply-report', 'warning', 'apply-report.json is missing'));
  } else if (!applyReport.succeeded) {
    checks.push(check('apply-report', 'error', 'apply-report.json reports a failed apply'));
  } else {
    checks.push(check('apply-report', 'ok', 'apply-report.json reports a successful apply'));
  }

  const summary = summarizeChecks(checks);
  const report: VerifyReport = {
    bundle: bundleDir,
    checks,
    generatedAt,
    ok: summary.errors === 0,
    summary,
  };

  if (options.writeReport !== false) {
    await writeVerifyReport(bundleDir, report);
  }

  return report;
}
