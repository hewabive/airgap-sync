import path from 'node:path';
import semver from 'semver';
import * as fs from './fs.js';
import { readBundleManifest, readDistTagsManifest, writeVerifyReport } from './bundle.js';
import { inspectPackageTarball, TarballInspectionCache } from './tarball.js';
import { validateBundle } from './validation.js';
import { assertNpmSecurityGate } from './security.js';
import type {
  ApplyBundleReport,
  BundleManifest,
  CollectReport,
  DistTagsManifest,
  FetchReport,
  GitSourcesManifest,
  RootPackageRequirement,
  VerifyCheck,
  VerifyCheckStatus,
  VerifyReport,
} from '../types.js';
import type { WorkspaceSnapshot } from './workspace.js';
import type { PythonFetchReport, PythonSeedManifest } from './python/bundle.js';
import { verifyPythonBundle } from './python/verify.js';
import { assertPythonSecurityGate } from './python/security.js';
import {
  pythonApplicationManifestCoverageErrors,
  readPythonApplicationBundleIndex,
  verifyPythonApplicationBundle,
  type PythonApplicationDownloadReport,
} from './python/application-bundle.js';
import { pythonApplicationIndexPath } from './python/application-paths.js';
import { readGitSourceManifestRequirements } from './git-manifests.js';
import { isPackageManagerRequirement } from './package-managers.js';
import {
  cpythonDistributionFetchReportPath,
  cpythonDistributionIndexPath,
  verifyCpythonDistributionBundle,
  type CpythonDistributionDownloadReport,
} from './python/distribution-bundle.js';

export interface VerifyBundleOptions {
  /** Explicit compatibility escape hatch for schemaVersion 1 bundles. */
  allowLegacyBundle?: boolean;
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

function packageManagerRequirementIsPresent(
  manifest: BundleManifest,
  requirement: RootPackageRequirement
): boolean {
  return manifest.packages.some((pkg) => {
    if (pkg.name !== requirement.name) {
      return false;
    }

    if (requirement.type === 'version') {
      return pkg.version === requirement.specifier;
    }

    if (requirement.type === 'range') {
      return semver.satisfies(pkg.version, requirement.specifier, {
        includePrerelease: true,
      });
    }

    return false;
  });
}

async function verifyPackageManagerRequirements(
  bundleDir: string,
  gitSources: GitSourcesManifest | undefined,
  manifest: BundleManifest | undefined
): Promise<VerifyCheck | undefined> {
  if (!gitSources || !manifest || gitSources.sources.length === 0) {
    return undefined;
  }

  const requirements: RootPackageRequirement[] = [];
  const scanErrors: { error: string; sourceId: string }[] = [];

  for (const source of gitSources.sources) {
    const sourceMirrorPath = mirrorPath(bundleDir, source.localMirrorPath);
    if (!(await fs.pathExists(sourceMirrorPath))) {
      continue;
    }

    try {
      const parsed = await readGitSourceManifestRequirements({
        mirrorPath: sourceMirrorPath,
        source,
      });
      requirements.push(...parsed.requirements.filter(isPackageManagerRequirement));
    } catch (error) {
      scanErrors.push({
        error: (error as Error).message,
        sourceId: source.id,
      });
    }
  }

  if (scanErrors.length > 0) {
    return check(
      'package-manager-requirements',
      'error',
      `${String(scanErrors.length)} Git sources could not be checked for package manager requirements`,
      { errors: scanErrors }
    );
  }

  const missing = requirements.filter(
    (requirement) => !packageManagerRequirementIsPresent(manifest, requirement)
  );
  if (missing.length > 0) {
    return check(
      'package-manager-requirements',
      'error',
      `${String(missing.length)}/${String(requirements.length)} package manager requirements are missing from the bundle`,
      { missing }
    );
  }

  return check(
    'package-manager-requirements',
    'ok',
    requirements.length === 0
      ? 'Git sources declare no pnpm package manager bootstrap requirements'
      : `${String(requirements.length)}/${String(requirements.length)} package manager requirements are present`
  );
}

async function verifyTarballIntegrity(
  bundleDir: string,
  manifest: BundleManifest,
  inspectionCache: TarballInspectionCache
): Promise<VerifyCheck> {
  const corrupt: { error: string; file: string }[] = [];
  const mismatched: {
    actualName: string;
    actualVersion: string;
    expectedName: string;
    expectedVersion: string;
    file: string;
  }[] = [];

  for (const pkg of manifest.packages) {
    const tarballPath = path.join(bundleDir, pkg.file);
    if (!(await fs.pathExists(tarballPath))) {
      continue;
    }

    try {
      const packageManifest = (await inspectPackageTarball(tarballPath, pkg, inspectionCache))
        .manifest;
      if (packageManifest.name !== pkg.name || packageManifest.version !== pkg.version) {
        mismatched.push({
          actualName: packageManifest.name,
          actualVersion: packageManifest.version,
          expectedName: pkg.name,
          expectedVersion: pkg.version,
          file: pkg.file,
        });
      }
    } catch (error) {
      corrupt.push({
        error: (error as Error).message,
        file: pkg.file,
      });
    }
  }

  if (corrupt.length > 0 || mismatched.length > 0) {
    return check(
      'tarball-integrity',
      'error',
      `${String(corrupt.length)} unreadable tarballs, ${String(mismatched.length)} metadata mismatches`,
      { corrupt, mismatched }
    );
  }

  return check(
    'tarball-integrity',
    'ok',
    `${String(manifest.packages.length)}/${String(manifest.packages.length)} tarballs are readable`
  );
}

export async function verifyBundle(options: VerifyBundleOptions): Promise<VerifyReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const inspectionCache = new TarballInspectionCache();
  const checks: VerifyCheck[] = [];
  const { checks: manifestChecks, distTags, manifest } = await safeReadManifests(bundleDir);
  checks.push(...manifestChecks);

  if (manifest && distTags) {
    const validation = await validateBundle(bundleDir, manifest, distTags, { inspectionCache });
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

    checks.push(await verifyTarballIntegrity(bundleDir, manifest, inspectionCache));

    if (options.allowLegacyBundle !== true) {
      try {
        const security = await assertNpmSecurityGate(bundleDir, manifest, {
          now: new Date(generatedAt),
        });
        checks.push(
          check(
            'npm-security',
            'ok',
            `OSV/static security report passed for ${String(security.packageCount)} npm packages`
          )
        );
        const warningFindings = [
          ...security.advisories.filter((finding) => finding.severity === 'warning'),
          ...security.staticFindings.filter((finding) => finding.severity === 'warning'),
        ];
        if (warningFindings.length > 0) {
          checks.push(
            check(
              'npm-security-warnings',
              'warning',
              `${String(warningFindings.length)} non-blocking npm security findings require review`,
              { findings: warningFindings }
            )
          );
        }
      } catch (error) {
        checks.push(check('npm-security', 'error', (error as Error).message));
      }
    }
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

  const pythonManifestPath = path.join(bundleDir, 'python-seed-manifest.json');
  const hasPythonManifest = await fs.pathExists(pythonManifestPath);
  if (hasPythonManifest) {
    try {
      const pythonManifest = await fs.readJson<PythonSeedManifest>(pythonManifestPath);
      let pythonFetchReport: PythonFetchReport | undefined;
      try {
        pythonFetchReport = await readOptionalJson<PythonFetchReport>(
          path.join(bundleDir, 'python-fetch-report.json')
        );
      } catch (error) {
        checks.push(
          check('python-fetch-report', 'error', 'python-fetch-report.json is unreadable', {
            error: (error as Error).message,
          })
        );
      }
      checks.push(
        ...(await verifyPythonBundle({
          bundleDir,
          ...(pythonFetchReport ? { fetchReport: pythonFetchReport } : {}),
          manifest: pythonManifest,
        }))
      );
      try {
        const pythonSecurity = await assertPythonSecurityGate(bundleDir, pythonManifest, {
          now: new Date(generatedAt),
        });
        checks.push(
          check(
            'python-security',
            'ok',
            `OSV security report passed for ${String(pythonSecurity.packageCount)} Python packages`
          )
        );
        const warnings = pythonSecurity.advisories.filter(
          (finding) => finding.severity === 'warning'
        );
        if (warnings.length > 0) {
          checks.push(
            check(
              'python-security-warnings',
              'warning',
              `${String(warnings.length)} Python vulnerability advisories require review`,
              { findings: warnings }
            )
          );
        }
      } catch (error) {
        checks.push(check('python-security', 'error', (error as Error).message));
      }
    } catch (error) {
      checks.push(
        check('python-seed-manifest', 'error', 'python-seed-manifest.json is unreadable', {
          error: (error as Error).message,
        })
      );
    }
  } else if (workspaceSnapshot?.pythonTargetEnvironments?.length || fetchReport?.python?.enabled) {
    checks.push(
      check(
        'python-seed-manifest',
        'error',
        'Python target environments are configured but python-seed-manifest.json is missing'
      )
    );
  }

  const hasPythonApplicationIndex = await fs.pathExists(
    path.join(bundleDir, pythonApplicationIndexPath)
  );
  if (hasPythonApplicationIndex) {
    if (!hasPythonManifest) {
      checks.push(
        check(
          'python-seed-manifest',
          'error',
          'python-seed-manifest.json is required by the Python application bundle'
        )
      );
    }
    try {
      if (hasPythonManifest) {
        const [applicationIndex, pythonManifest] = await Promise.all([
          readPythonApplicationBundleIndex(bundleDir),
          fs.readJson<PythonSeedManifest>(pythonManifestPath),
        ]);
        const coverageErrors = applicationIndex
          ? pythonApplicationManifestCoverageErrors(applicationIndex, pythonManifest)
          : [];
        checks.push(
          coverageErrors.length === 0
            ? check(
                'python-application-security-coverage',
                'ok',
                'All Python application wheels are covered by the security manifest'
              )
            : check(
                'python-application-security-coverage',
                'error',
                `${String(coverageErrors.length)} Python application wheels are absent from the security manifest`,
                { errors: coverageErrors }
              )
        );
      }
      const result = await verifyPythonApplicationBundle(bundleDir);
      checks.push(
        result.errors.length === 0
          ? check(
              'python-applications',
              'ok',
              `${String(result.applications)} Python application plans and ${String(result.artifacts)} artifacts are valid`
            )
          : check(
              'python-applications',
              'error',
              `${String(result.errors.length)} Python application bundle errors`,
              { errors: result.errors }
            )
      );
      try {
        const applicationFetchReport = await readOptionalJson<PythonApplicationDownloadReport>(
          path.join(bundleDir, 'python-application-fetch-report.json')
        );
        checks.push(
          !applicationFetchReport
            ? check(
                'python-application-fetch-report',
                'warning',
                'python-application-fetch-report.json is missing'
              )
            : applicationFetchReport.errors.length > 0
              ? check(
                  'python-application-fetch-report',
                  'error',
                  `${String(applicationFetchReport.errors.length)} Python application fetch errors`,
                  { errors: applicationFetchReport.errors }
                )
              : check(
                  'python-application-fetch-report',
                  'ok',
                  'python-application-fetch-report.json has no errors'
                )
        );
      } catch (error) {
        checks.push(
          check(
            'python-application-fetch-report',
            'error',
            'python-application-fetch-report.json is unreadable',
            { error: (error as Error).message }
          )
        );
      }
    } catch (error) {
      checks.push(
        check('python-applications', 'error', 'Python application bundle index is unreadable', {
          error: (error as Error).message,
        })
      );
    }
  } else if (
    workspaceSnapshot?.targets.some((target) => target.type === 'python-app') ||
    (await fs.pathExists(path.join(bundleDir, 'python-application-fetch-report.json')))
  ) {
    checks.push(
      check(
        'python-applications',
        'error',
        `${pythonApplicationIndexPath} is missing for configured Python applications`
      )
    );
  }

  const hasCpythonDistributionIndex = await fs.pathExists(
    path.join(bundleDir, cpythonDistributionIndexPath)
  );
  if (hasCpythonDistributionIndex) {
    try {
      const errors = await verifyCpythonDistributionBundle(bundleDir);
      checks.push(
        errors.length === 0
          ? check('cpython-distributions', 'ok', 'CPython distribution artifacts are valid')
          : check(
              'cpython-distributions',
              'error',
              `${String(errors.length)} CPython distribution bundle errors`,
              { errors }
            )
      );
      try {
        const distributionFetchReport = await readOptionalJson<CpythonDistributionDownloadReport>(
          path.join(bundleDir, cpythonDistributionFetchReportPath)
        );
        checks.push(
          !distributionFetchReport
            ? check(
                'cpython-distribution-fetch-report',
                'warning',
                `${cpythonDistributionFetchReportPath} is missing`
              )
            : distributionFetchReport.errors.length > 0
              ? check(
                  'cpython-distribution-fetch-report',
                  'error',
                  `${String(distributionFetchReport.errors.length)} CPython distribution fetch errors`,
                  { errors: distributionFetchReport.errors }
                )
              : check(
                  'cpython-distribution-fetch-report',
                  'ok',
                  'CPython distribution fetch report has no errors'
                )
        );
      } catch (error) {
        checks.push(
          check(
            'cpython-distribution-fetch-report',
            'error',
            `${cpythonDistributionFetchReportPath} is unreadable`,
            { error: (error as Error).message }
          )
        );
      }
    } catch (error) {
      checks.push(
        check('cpython-distributions', 'error', `${cpythonDistributionIndexPath} is unreadable`, {
          error: (error as Error).message,
        })
      );
    }
  } else if (
    workspaceSnapshot?.targets.some((target) => target.type === 'cpython-distributions') ||
    (await fs.pathExists(path.join(bundleDir, cpythonDistributionFetchReportPath)))
  ) {
    checks.push(
      check(
        'cpython-distributions',
        'error',
        `${cpythonDistributionIndexPath} is missing for configured CPython distributions`
      )
    );
  }

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
  const packageManagerCheck = await verifyPackageManagerRequirements(
    bundleDir,
    gitSources,
    manifest
  );
  if (packageManagerCheck) {
    checks.push(packageManagerCheck);
  }

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
