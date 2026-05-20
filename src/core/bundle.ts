import path from 'node:path';
import fs from 'fs-extra';
import type {
  BundleManifest,
  DistTagsManifest,
  FetchReport,
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
  resolved: number;
  skipped: number;
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
    resolved: options.resolved,
    skipped: options.skipped,
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
