import path from 'node:path';
import fs from 'fs-extra';
import type {
  BundleManifest,
  CollectReport,
  DistTagsManifest,
  FetchReport,
  FetchTimings,
  GiteaRepositoryProvisionReport,
  GitApplyReport,
  GitConfigReport,
  GitFetchReport,
  GitRequirement,
  PublishReport,
  ResolvedPackage,
  ResolvedRootPackage,
  ResolutionError,
  TagRequirement,
  UnsupportedRootPackageRequirement,
} from '../types.js';
import { packageFileName } from './files.js';

export interface BundleDocumentsOptions {
  createdAt?: string;
  outputDir: string;
  resolved: ResolvedRootPackage[];
  sourceRegistry: string;
  tagRequirements: TagRequirement[];
}

export interface BundleDocuments {
  distTagsManifest: DistTagsManifest;
  manifest: BundleManifest;
}

export interface FetchReportOptions {
  downloaded: number;
  errors: ResolutionError[];
  generatedAt?: string;
  gitRequirements: GitRequirement[];
  resolved: number;
  skipped: number;
  timings?: FetchTimings;
  unsupported: UnsupportedRootPackageRequirement[];
}

export function createBundleDocuments(options: BundleDocumentsOptions): BundleDocuments {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const packages: ResolvedPackage[] = options.resolved.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    file: path.posix.join('packages', packageFileName(pkg.name, pkg.version)),
    tarball: pkg.dist.tarball,
    resolvedFrom: [
      {
        raw: pkg.raw,
        requiredBy: pkg.requiredBy,
        specifier: pkg.specifier,
        type: pkg.type,
      },
    ],
  }));

  const tags: Record<string, Record<string, string>> = {};
  for (const requirement of options.tagRequirements) {
    const packageTags = (tags[requirement.name] ??= {});
    packageTags[requirement.tag] = requirement.version;
  }

  return {
    manifest: {
      schemaVersion: 1,
      createdAt,
      sourceRegistry: options.sourceRegistry,
      packages,
    },
    distTagsManifest: {
      schemaVersion: 1,
      createdAt,
      sourceRegistry: options.sourceRegistry,
      tags,
      requirements: options.tagRequirements,
    },
  };
}

export function createFetchReport(options: FetchReportOptions): FetchReport {
  return {
    downloaded: options.downloaded,
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
  return (await fs.readJson(path.join(bundleDir, 'fetch-report.json'))) as FetchReport;
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
  return (await fs.readJson(path.join(bundleDir, 'seed-manifest.json'))) as BundleManifest;
}

export async function readDistTagsManifest(bundleDir: string): Promise<DistTagsManifest> {
  return (await fs.readJson(path.join(bundleDir, 'dist-tags.json'))) as DistTagsManifest;
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
