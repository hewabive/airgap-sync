import path from 'node:path';
import fs from 'fs-extra';
import type { BundleManifest, DistTagsManifest } from '../types.js';

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

async function validateTarballs(
  bundleDir: string,
  manifest: BundleManifest
): Promise<BundleValidationIssue[]> {
  const issues: BundleValidationIssue[] = [];

  for (const pkg of manifest.packages) {
    if (!isSafeBundleFile(pkg.file)) {
      issues.push(
        issue(
          'unsafe-package-file',
          `${packageId(pkg)} references an unsafe package file path: ${pkg.file}`
        )
      );
      continue;
    }

    if (!(await fs.pathExists(path.join(bundleDir, pkg.file)))) {
      issues.push(issue('missing-tarball', `${packageId(pkg)} tarball is missing: ${pkg.file}`));
    }
  }

  return issues;
}

export async function validateBundle(
  bundleDir: string,
  manifest: BundleManifest,
  distTags: DistTagsManifest
): Promise<BundleValidationResult> {
  const issues: BundleValidationIssue[] = [];
  const manifestSchemaVersion = (manifest as { schemaVersion: number }).schemaVersion;
  const distTagsSchemaVersion = (distTags as { schemaVersion: number }).schemaVersion;

  if (manifestSchemaVersion !== 1) {
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

  issues.push(...(await validateTarballs(bundleDir, manifest)));

  return {
    issues,
    valid: issues.length === 0,
  };
}

export function throwIfInvalidBundle(validation: BundleValidationResult): void {
  if (validation.valid) {
    return;
  }

  const details = validation.issues.map((item) => `${item.code}: ${item.message}`).join('\n');
  throw new Error(`Invalid airgap bundle:\n${details}`);
}
