import path from 'node:path';
import * as fs from './fs.js';
import type { BundleManifest, DistTagsManifest, FetchReport, PublishReport } from '../types.js';
import { readBundleManifest, readDistTagsManifest } from './bundle.js';
import { validateBundle, type BundleValidationIssue } from './validation.js';

export interface BundleInfoPackage {
  file: string;
  name: string;
  reasons: number;
  version: string;
}

export interface BundleInfoTag {
  name: string;
  tag: string;
  version: string;
}

export interface BundleInfoReportStatus {
  errors: number;
  exists: boolean;
  generatedAt?: string;
}

export interface BundleInfo {
  bundle: string;
  createdAt: string;
  fetchReport: BundleInfoReportStatus;
  missingTarballs: string[];
  packageCount: number;
  packageNameCount: number;
  packages: BundleInfoPackage[];
  publishReport: BundleInfoReportStatus;
  sourceRegistry: string;
  tagCount: number;
  tags: BundleInfoTag[];
  validationIssues: BundleValidationIssue[];
  valid: boolean;
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }

  return fs.readJson<T>(filePath);
}

function reportStatus(report: FetchReport | PublishReport | undefined): BundleInfoReportStatus {
  if (!report) {
    return { exists: false, errors: 0 };
  }

  return {
    exists: true,
    errors: report.errors.length,
    generatedAt: report.generatedAt,
  };
}

function tagsFromManifest(distTags: DistTagsManifest): BundleInfoTag[] {
  const tags: BundleInfoTag[] = [];

  for (const [name, packageTags] of Object.entries(distTags.tags)) {
    for (const [tag, version] of Object.entries(packageTags)) {
      tags.push({ name, tag, version });
    }
  }

  return tags.sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    return byName === 0 ? left.tag.localeCompare(right.tag) : byName;
  });
}

function packagesFromManifest(manifest: BundleManifest): BundleInfoPackage[] {
  return manifest.packages
    .map((pkg) => ({
      file: pkg.file,
      name: pkg.name,
      reasons: pkg.resolvedFrom.length,
      version: pkg.version,
    }))
    .sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      return byName === 0 ? left.version.localeCompare(right.version) : byName;
    });
}

async function missingTarballs(bundleDir: string, manifest: BundleManifest): Promise<string[]> {
  const missing: string[] = [];

  for (const pkg of manifest.packages) {
    if (!(await fs.pathExists(path.join(bundleDir, pkg.file)))) {
      missing.push(pkg.file);
    }
  }

  return missing.sort();
}

export async function readBundleInfo(bundleDir: string): Promise<BundleInfo> {
  const manifest = await readBundleManifest(bundleDir);
  const distTags = await readDistTagsManifest(bundleDir);
  const [fetchReport, publishReport, missing] = await Promise.all([
    readOptionalJson<FetchReport>(path.join(bundleDir, 'fetch-report.json')),
    readOptionalJson<PublishReport>(path.join(bundleDir, 'publish-report.json')),
    missingTarballs(bundleDir, manifest),
  ]);

  const packageNames = new Set(manifest.packages.map((pkg) => pkg.name));
  const tags = tagsFromManifest(distTags);
  const validation = await validateBundle(bundleDir, manifest, distTags);

  return {
    bundle: path.resolve(bundleDir),
    createdAt: manifest.createdAt,
    fetchReport: reportStatus(fetchReport),
    missingTarballs: missing,
    packageCount: manifest.packages.length,
    packageNameCount: packageNames.size,
    packages: packagesFromManifest(manifest),
    publishReport: reportStatus(publishReport),
    sourceRegistry: manifest.sourceRegistry,
    tagCount: tags.length,
    tags,
    validationIssues: validation.issues,
    valid: validation.valid,
  };
}
