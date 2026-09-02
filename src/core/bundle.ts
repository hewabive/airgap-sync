import path from 'node:path';
import * as fs from './fs.js';
import type {
  ApplyBundleReport,
  BundleManifest,
  CollectReport,
  DistTagsManifest,
  FetchReport,
  FetchPackageAction,
  FetchTimings,
  GiteaRepositoryProvisionReport,
  GitApplyReport,
  GitConfigReport,
  GitFetchReport,
  GitRequirement,
  LatestPolicy,
  PublishReport,
  ResolvedPackage,
  ResolvedRootPackage,
  ResolutionError,
  ResolutionWarning,
  TagRequirement,
  UnsupportedRootPackageRequirement,
  VulnerabilityResolutionAction,
  VerifyReport,
  VerifyInstallReport,
} from '../types.js';
import { packageFileName } from './files.js';
import type { WorkspaceSnapshot } from './workspace.js';

export interface BundleDocumentsOptions {
  createdAt?: string;
  latestPolicy?: LatestPolicy;
  outputDir: string;
  resolved: ResolvedRootPackage[];
  sourceRegistry: string;
  tagRequirements: TagRequirement[];
}

export interface BundleDocuments {
  distTagsManifest: DistTagsManifest;
  manifest: BundleManifest;
}

function packageIdentity(value: { name: string; version: string }): string {
  return `${value.name}\0${value.version}`;
}

function resolutionReasonIdentity(value: ResolvedPackage['resolvedFrom'][number]): string {
  return [value.requiredBy, value.raw, value.specifier, value.type].join('\0');
}

function tagRequirementIdentity(value: TagRequirement): string {
  return [value.name, value.tag, value.version, value.requiredBy].join('\0');
}

export interface FetchReportOptions {
  downloaded: number;
  downloadedPackages?: FetchPackageAction[];
  errors: ResolutionError[];
  generatedAt?: string;
  gitRequirements: GitRequirement[];
  resolved: number;
  skipped: number;
  timings?: FetchTimings;
  unsupported: UnsupportedRootPackageRequirement[];
  vulnerabilityResolutions?: VulnerabilityResolutionAction[];
  warnings?: ResolutionWarning[];
  wouldDownloadPackages?: FetchPackageAction[];
}

function isArtificialSourceLatestRequirement(requirement: TagRequirement): boolean {
  return requirement.tag === 'latest' && requirement.requiredBy === 'airgap-sync:publish-latest';
}

function tagRequirementsForPolicy(options: BundleDocumentsOptions): TagRequirement[] {
  if ((options.latestPolicy ?? 'bundled') === 'source') {
    return options.tagRequirements.filter(
      (requirement) => requirement.requiredBy !== 'airgap-sync:bundled-latest'
    );
  }

  return options.tagRequirements.filter(
    (requirement) =>
      requirement.requiredBy !== 'airgap-sync:bundled-latest' &&
      !isArtificialSourceLatestRequirement(requirement)
  );
}

export function createBundleDocuments(options: BundleDocumentsOptions): BundleDocuments {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const tagRequirements = tagRequirementsForPolicy(options);
  const packages: ResolvedPackage[] = options.resolved.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    file: path.posix.join('packages', packageFileName(pkg.name, pkg.version)),
    ...(pkg.dist.integrity ? { integrity: pkg.dist.integrity } : {}),
    ...(pkg.publishedAt ? { publishedAt: pkg.publishedAt } : {}),
    ...(pkg.sha256 ? { sha256: pkg.sha256 } : {}),
    ...(pkg.dist.shasum ? { shasum: pkg.dist.shasum } : {}),
    tarball: pkg.dist.tarball,
    resolvedFrom: pkg.resolvedFrom ?? [
      {
        raw: pkg.raw,
        requiredBy: pkg.requiredBy,
        specifier: pkg.specifier,
        type: pkg.type,
      },
    ],
  }));

  const tags: Record<string, Record<string, string>> = {};
  for (const requirement of tagRequirements) {
    const packageTags = (tags[requirement.name] ??= {});
    packageTags[requirement.tag] = requirement.version;
  }

  return {
    manifest: {
      schemaVersion:
        packages.length === 0 || packages.every((pkg) => pkg.sha256 !== undefined) ? 2 : 1,
      createdAt,
      sourceRegistry: options.sourceRegistry,
      packages,
    },
    distTagsManifest: {
      schemaVersion: 1,
      createdAt,
      sourceRegistry: options.sourceRegistry,
      tags,
      requirements: tagRequirements,
    },
  };
}

/**
 * Preserve the previously active npm graph while replacing everything refreshed by the
 * current collection. This is used by partial and paused-target downloads so pruning can
 * continue to rely on the active bundle documents. Retention is deliberately conservative
 * because legacy manifests do not carry complete per-target ownership.
 */
export function mergeBundleDocuments(
  current: BundleDocuments,
  retained: BundleDocuments | undefined
): BundleDocuments {
  if (!retained) return current;

  const packages = new Map(
    retained.manifest.packages.map((pkg) => [packageIdentity(pkg), pkg] as const)
  );
  for (const pkg of current.manifest.packages) {
    const previous = packages.get(packageIdentity(pkg));
    if (!previous) {
      packages.set(packageIdentity(pkg), pkg);
      continue;
    }
    const reasons = new Map(
      [...previous.resolvedFrom, ...pkg.resolvedFrom].map((reason) => [
        resolutionReasonIdentity(reason),
        reason,
      ])
    );
    packages.set(packageIdentity(pkg), {
      ...pkg,
      resolvedFrom: [...reasons.values()].sort((left, right) =>
        resolutionReasonIdentity(left).localeCompare(resolutionReasonIdentity(right))
      ),
    });
  }
  const mergedPackages = [...packages.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  );

  const tags: DistTagsManifest['tags'] = {};
  for (const [name, packageTags] of Object.entries(retained.distTagsManifest.tags)) {
    tags[name] = { ...packageTags };
  }
  for (const [name, packageTags] of Object.entries(current.distTagsManifest.tags)) {
    tags[name] = { ...(tags[name] ?? {}), ...packageTags };
  }
  const requirements = new Map<string, TagRequirement>();
  for (const requirement of [
    ...retained.distTagsManifest.requirements,
    ...current.distTagsManifest.requirements,
  ]) {
    if (tags[requirement.name]?.[requirement.tag] === requirement.version) {
      requirements.set(tagRequirementIdentity(requirement), requirement);
    }
  }

  return {
    distTagsManifest: {
      schemaVersion: 1,
      createdAt: current.distTagsManifest.createdAt,
      sourceRegistry: current.distTagsManifest.sourceRegistry,
      tags,
      requirements: [...requirements.values()].sort((left, right) =>
        tagRequirementIdentity(left).localeCompare(tagRequirementIdentity(right))
      ),
    },
    manifest: {
      schemaVersion:
        mergedPackages.length === 0 || mergedPackages.every((pkg) => pkg.sha256 !== undefined)
          ? 2
          : 1,
      createdAt: current.manifest.createdAt,
      sourceRegistry: current.manifest.sourceRegistry,
      packages: mergedPackages,
    },
  };
}

export function createFetchReport(options: FetchReportOptions): FetchReport {
  return {
    downloaded: options.downloaded,
    downloadedPackages: options.downloadedPackages ?? [],
    errors: options.errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    gitRequirements: options.gitRequirements,
    resolved: options.resolved,
    skipped: options.skipped,
    timings: options.timings ?? {
      dependencyScanMs: 0,
      downloadMs: 0,
      manifestReadMs: 0,
      resolveMs: 0,
      totalMs: 0,
    },
    unsupported: options.unsupported,
    ...(options.vulnerabilityResolutions
      ? { vulnerabilityResolutions: options.vulnerabilityResolutions }
      : {}),
    ...(options.warnings && options.warnings.length > 0 ? { warnings: options.warnings } : {}),
    wouldDownloadPackages: options.wouldDownloadPackages ?? [],
  };
}

export async function writeBundleDocuments(
  outputDir: string,
  documents: BundleDocuments
): Promise<void> {
  await fs.ensureDir(outputDir);
  await fs.writeJson(path.join(outputDir, 'seed-manifest.json'), documents.manifest, { spaces: 2 });
  await fs.writeJson(path.join(outputDir, 'dist-tags.json'), documents.distTagsManifest, {
    spaces: 2,
  });
}

export async function writeFetchReport(outputDir: string, report: FetchReport): Promise<void> {
  await fs.ensureDir(outputDir);
  await fs.writeJson(path.join(outputDir, 'fetch-report.json'), report, { spaces: 2 });
}

export async function writeCollectReport(outputDir: string, report: CollectReport): Promise<void> {
  await fs.ensureDir(outputDir);
  await fs.writeJson(path.join(outputDir, 'collect-report.json'), report, { spaces: 2 });
}

export async function readFetchReport(bundleDir: string): Promise<FetchReport> {
  return fs.readJson<FetchReport>(path.join(bundleDir, 'fetch-report.json'));
}

export async function writeGitFetchReport(
  bundleDir: string,
  report: GitFetchReport
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'git-fetch-report.json'), report, { spaces: 2 });
}

export async function writeGitApplyReport(
  bundleDir: string,
  report: GitApplyReport
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'git-apply-report.json'), report, { spaces: 2 });
}

export async function writeGitConfigReport(
  bundleDir: string,
  report: GitConfigReport
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'git-config-report.json'), report, { spaces: 2 });
}

export async function writeGiteaRepositoryProvisionReport(
  bundleDir: string,
  report: GiteaRepositoryProvisionReport
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'gitea-repos-report.json'), report, { spaces: 2 });
}

export async function readBundleManifest(bundleDir: string): Promise<BundleManifest> {
  return fs.readJson<BundleManifest>(path.join(bundleDir, 'seed-manifest.json'));
}

export async function readDistTagsManifest(bundleDir: string): Promise<DistTagsManifest> {
  return fs.readJson<DistTagsManifest>(path.join(bundleDir, 'dist-tags.json'));
}

export async function writePublishReport(bundleDir: string, report: PublishReport): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(
    path.join(bundleDir, report.dryRun ? 'publish-dry-run-report.json' : 'publish-report.json'),
    report,
    {
      spaces: 2,
    }
  );
}

export async function writeApplyReport(
  bundleDir: string,
  report: ApplyBundleReport
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(
    path.join(bundleDir, report.dryRun ? 'apply-dry-run-report.json' : 'apply-report.json'),
    report,
    {
      spaces: 2,
    }
  );
}

export async function writeWorkspaceSnapshot(
  bundleDir: string,
  snapshot: WorkspaceSnapshot
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJsonAtomic(path.join(bundleDir, 'workspace-snapshot.json'), snapshot, {
    spaces: 2,
  });
}

export async function writeVerifyReport(bundleDir: string, report: VerifyReport): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'verify-report.json'), report, { spaces: 2 });
}

export async function writeVerifyInstallReport(
  bundleDir: string,
  report: VerifyInstallReport
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'verify-install-report.json'), report, { spaces: 2 });
}
