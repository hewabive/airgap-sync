import path from 'node:path';
import * as fs from './fs.js';
import type { BundleManifest, DistTagsManifest } from '../types.js';
import { inspectPackageTarball, type TarballInspectionCache } from './tarball.js';

const defaultTarballValidationConcurrency = 4;

export type BundleValidationSeverity = 'error';

export interface BundleValidationIssue {
  code: string;
  message: string;
  severity: BundleValidationSeverity;
}

export interface BundleValidationResult {
  issues: BundleValidationIssue[];
  valid: boolean;
}

export interface BundleTarballValidationOptions {
  concurrency?: number;
  inspectionCache?: TarballInspectionCache;
  onProgress?: (event: { current: number; package: string; total: number }) => void;
}

type ManifestPackage = BundleManifest['packages'][number];

function packageId(pkg: { name: string; version: string }): string {
  return `${pkg.name}@${pkg.version}`;
}

function issue(code: string, message: string): BundleValidationIssue {
  return {
    code,
    message,
    severity: 'error',
  };
}

function isSafeBundleFile(file: string): boolean {
  return (
    file.length > 0 &&
    !path.isAbsolute(file) &&
    !file.split(/[\\/]/u).includes('..') &&
    file.startsWith('packages/')
  );
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      const item = items[currentIndex];
      if (item === undefined) continue;
      results[currentIndex] = await mapper(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => worker())
  );
  return results;
}

function validationResult(issues: BundleValidationIssue[]): BundleValidationResult {
  return {
    issues,
    valid: issues.length === 0,
  };
}

function mergeValidationResults(...results: BundleValidationResult[]): BundleValidationResult {
  const seen = new Set<string>();
  const issues = results.flatMap((result) =>
    result.issues.filter((item) => {
      const key = `${item.code}\0${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
  );
  return validationResult(issues);
}

export async function validateBundleTarballs(
  bundleDir: string,
  manifest: BundleManifest,
  packages: readonly ManifestPackage[] = manifest.packages,
  options: BundleTarballValidationOptions = {}
): Promise<BundleValidationResult> {
  const concurrency =
    options.concurrency === undefined || !Number.isFinite(options.concurrency)
      ? defaultTarballValidationConcurrency
      : Math.max(1, Math.floor(options.concurrency));
  let completed = 0;
  const packageIssues = await mapWithConcurrency(
    packages,
    concurrency,
    async (pkg): Promise<BundleValidationIssue[]> => {
      const issues: BundleValidationIssue[] = [];
      if (!isSafeBundleFile(pkg.file)) {
        issues.push(
          issue(
            'unsafe-package-file',
            `${packageId(pkg)} references an unsafe package file path: ${pkg.file}`
          )
        );
      } else if (manifest.schemaVersion === 2) {
        if (!pkg.sha256) {
          issues.push(
            (await fs.pathExists(path.join(bundleDir, pkg.file)))
              ? issue('missing-sha256', `${packageId(pkg)} has no SHA-256 digest`)
              : issue('missing-tarball', `${packageId(pkg)} tarball is missing: ${pkg.file}`)
          );
        } else {
          try {
            const inspection = await inspectPackageTarball(
              path.join(bundleDir, pkg.file),
              pkg,
              options.inspectionCache
            );
            if (
              inspection.manifest.name !== pkg.name ||
              inspection.manifest.version !== pkg.version
            ) {
              issues.push(
                issue(
                  'tarball-metadata-mismatch',
                  `${packageId(pkg)} tarball contains ${inspection.manifest.name}@${inspection.manifest.version}`
                )
              );
            }
          } catch (error) {
            issues.push(
              isMissingFileError(error)
                ? issue('missing-tarball', `${packageId(pkg)} tarball is missing: ${pkg.file}`)
                : issue(
                    'registry-integrity-mismatch',
                    `${packageId(pkg)}: ${(error as Error).message}`
                  )
            );
          }
        }
      } else if (!(await fs.pathExists(path.join(bundleDir, pkg.file)))) {
        issues.push(issue('missing-tarball', `${packageId(pkg)} tarball is missing: ${pkg.file}`));
      }

      completed++;
      options.onProgress?.({
        current: completed,
        package: packageId(pkg),
        total: packages.length,
      });
      return issues;
    }
  );

  return validationResult(packageIssues.flat());
}

export function validateBundleStructure(
  manifest: BundleManifest,
  distTags: DistTagsManifest
): BundleValidationResult {
  const issues: BundleValidationIssue[] = [];
  const manifestSchemaVersion = (manifest as { schemaVersion: number }).schemaVersion;
  const distTagsSchemaVersion = (distTags as { schemaVersion: number }).schemaVersion;

  if (manifestSchemaVersion !== 1 && manifestSchemaVersion !== 2) {
    issues.push(
      issue('unsupported-seed-manifest-version', 'Unsupported seed-manifest schemaVersion')
    );
  }

  if (distTagsSchemaVersion !== 1) {
    issues.push(issue('unsupported-dist-tags-version', 'Unsupported dist-tags schemaVersion'));
  }

  if (manifest.sourceRegistry !== distTags.sourceRegistry) {
    issues.push(
      issue(
        'source-registry-mismatch',
        `Bundle source registries differ: ${manifest.sourceRegistry} !== ${distTags.sourceRegistry}`
      )
    );
  }

  const packageIds = new Set<string>();
  const duplicatePackageIds = new Set<string>();
  for (const pkg of manifest.packages) {
    const id = packageId(pkg);
    if (packageIds.has(id)) {
      duplicatePackageIds.add(id);
    }
    packageIds.add(id);
  }

  for (const id of duplicatePackageIds) {
    issues.push(
      issue('duplicate-package', `Package appears more than once in seed-manifest: ${id}`)
    );
  }

  for (const pkg of manifest.packages) {
    if (!isSafeBundleFile(pkg.file)) {
      issues.push(
        issue(
          'unsafe-package-file',
          `${packageId(pkg)} references an unsafe package file path: ${pkg.file}`
        )
      );
    }
    if (manifest.schemaVersion === 2 && !pkg.sha256) {
      issues.push(issue('missing-sha256', `${packageId(pkg)} has no SHA-256 digest`));
    }
  }

  for (const requirement of distTags.requirements) {
    const id = packageId(requirement);
    if (!packageIds.has(id)) {
      issues.push(
        issue(
          'tag-target-missing-package',
          `Tag ${requirement.name}@${requirement.tag} points to ${id}, which is not in seed-manifest`
        )
      );
    }

    const versionFromTags = distTags.tags[requirement.name]?.[requirement.tag];
    if (versionFromTags !== requirement.version) {
      issues.push(
        issue(
          'tag-requirement-mismatch',
          `Tag requirement ${requirement.name}@${requirement.tag}=${requirement.version} does not match dist-tags entry ${versionFromTags ?? '<missing>'}`
        )
      );
    }
  }

  for (const [name, packageTags] of Object.entries(distTags.tags)) {
    for (const [tag, version] of Object.entries(packageTags)) {
      const hasRequirement = distTags.requirements.some(
        (requirement) =>
          requirement.name === name && requirement.tag === tag && requirement.version === version
      );
      if (!hasRequirement) {
        issues.push(
          issue(
            'tag-entry-missing-requirement',
            `dist-tags entry ${name}@${tag}=${version} has no matching requirement`
          )
        );
      }
    }
  }

  return validationResult(issues);
}

export async function validateBundle(
  bundleDir: string,
  manifest: BundleManifest,
  distTags: DistTagsManifest,
  options: BundleTarballValidationOptions = {}
): Promise<BundleValidationResult> {
  return mergeValidationResults(
    validateBundleStructure(manifest, distTags),
    await validateBundleTarballs(bundleDir, manifest, manifest.packages, options)
  );
}

export function throwIfInvalidBundle(validation: BundleValidationResult): void {
  if (validation.valid) {
    return;
  }

  const details = validation.issues.map((item) => `${item.code}: ${item.message}`).join('\n');
  throw new Error(`Invalid airgap bundle:\n${details}`);
}
