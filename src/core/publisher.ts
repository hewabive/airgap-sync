import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  BundleManifest,
  DistTagsManifest,
  PublishActionResult,
  PublishReport,
  TagRequirement,
} from '../types.js';
import { isBlockedPublishRegistry } from './registry.js';
import { throwIfInvalidBundle, validateBundle } from './validation.js';

const execFileAsync = promisify(execFile);
const tempPublishTag = 'npm-registry-seed-temp';

export interface PublishBundleOptions {
  bundleDir: string;
  dryRun?: boolean;
  registryUrl: string;
  skipExisting?: boolean;
}

function packageId(pkg: { name: string; version: string }): string {
  return `${pkg.name}@${pkg.version}`;
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('409') ||
    message.toLowerCase().includes('conflict') ||
    message.includes('cannot publish over')
  );
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? 'Unknown error';
}

async function npmPublish(tarballPath: string, registryUrl: string): Promise<void> {
  await execFileAsync(
    'npm',
    [
      'publish',
      tarballPath,
      '--registry',
      registryUrl,
      '--tag',
      tempPublishTag,
      '--provenance',
      'false',
    ],
    {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    }
  );
}

async function npmDistTagAdd(requirement: TagRequirement, registryUrl: string): Promise<void> {
  await execFileAsync(
    'npm',
    [
      'dist-tag',
      'add',
      `${requirement.name}@${requirement.version}`,
      requirement.tag,
      '--registry',
      registryUrl,
    ],
    {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    }
  );
}

async function npmDistTagRemove(
  packageName: string,
  tag: string,
  registryUrl: string
): Promise<void> {
  await execFileAsync('npm', ['dist-tag', 'rm', packageName, tag, '--registry', registryUrl], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
}

async function npmPackageNameExists(packageName: string, registryUrl: string): Promise<boolean> {
  try {
    await execFileAsync('npm', ['view', packageName, 'version', '--registry', registryUrl], {
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function createPublishPlan(
  manifest: BundleManifest,
  distTags: DistTagsManifest
): PublishActionResult[] {
  return [
    ...manifest.packages.map((pkg) => ({
      action: 'publish' as const,
      package: packageId(pkg),
      status: 'planned' as const,
    })),
    ...distTags.requirements.map((requirement) => ({
      action: 'dist-tag' as const,
      package: packageId(requirement),
      status: 'planned' as const,
      tag: requirement.tag,
    })),
  ];
}

export async function publishBundle(
  manifest: BundleManifest,
  distTags: DistTagsManifest,
  options: PublishBundleOptions
): Promise<PublishReport> {
  if (isBlockedPublishRegistry(options.registryUrl)) {
    throw new Error(`Refusing to publish to public registry: ${options.registryUrl}`);
  }

  throwIfInvalidBundle(await validateBundle(options.bundleDir, manifest, distTags));

  const errors: PublishActionResult[] = [];
  let published = 0;
  let skipped = 0;
  let restoredTags = 0;
  const existingPackageNames = new Set<string>();
  const desiredTagsByPackage = new Map<string, Set<string>>();

  for (const requirement of distTags.requirements) {
    const tags = desiredTagsByPackage.get(requirement.name) ?? new Set<string>();
    tags.add(requirement.tag);
    desiredTagsByPackage.set(requirement.name, tags);
  }

  if (options.dryRun) {
    const plan = createPublishPlan(manifest, distTags);
    return {
      dryRun: true,
      errors: [],
      generatedAt: new Date().toISOString(),
      published: plan.filter((item) => item.action === 'publish').length,
      registry: options.registryUrl,
      restoredTags: plan.filter((item) => item.action === 'dist-tag').length,
      skipped: 0,
      totalPackages: manifest.packages.length,
    };
  }

  for (const pkg of manifest.packages) {
    if (existingPackageNames.has(pkg.name)) {
      continue;
    }

    if (await npmPackageNameExists(pkg.name, options.registryUrl)) {
      existingPackageNames.add(pkg.name);
    }
  }

  const missingLatest = new Set<string>();
  for (const pkg of manifest.packages) {
    const desiredTags = desiredTagsByPackage.get(pkg.name) ?? new Set<string>();
    if (!existingPackageNames.has(pkg.name) && !desiredTags.has('latest')) {
      missingLatest.add(pkg.name);
    }
  }

  if (missingLatest.size > 0) {
    throw new Error(
      [
        'Bundle is missing upstream latest tags for packages that do not exist in the target registry.',
        'Regenerate the bundle with a current npm-registry-seed fetch command.',
        `Packages: ${[...missingLatest].join(', ')}`,
      ].join(' ')
    );
  }

  for (const pkg of manifest.packages) {
    try {
      await npmPublish(path.join(options.bundleDir, pkg.file), options.registryUrl);
      published++;
    } catch (error) {
      if (options.skipExisting !== false && isAlreadyExistsError(error)) {
        skipped++;
        continue;
      }

      errors.push({
        action: 'publish',
        package: packageId(pkg),
        status: 'error',
        error: errorSummary(error),
      });
    }
  }

  if (errors.length === 0) {
    for (const requirement of distTags.requirements) {
      try {
        await npmDistTagAdd(requirement, options.registryUrl);
        restoredTags++;
      } catch (error) {
        errors.push({
          action: 'dist-tag',
          package: packageId(requirement),
          status: 'error',
          tag: requirement.tag,
          error: errorSummary(error),
        });
      }
    }

    for (const pkg of manifest.packages) {
      try {
        await npmDistTagRemove(pkg.name, tempPublishTag, options.registryUrl);
      } catch {
        // The temp tag may already be absent if the package existed before this run.
      }
    }
  }

  return {
    dryRun: false,
    errors,
    generatedAt: new Date().toISOString(),
    published,
    registry: options.registryUrl,
    restoredTags,
    skipped,
    totalPackages: manifest.packages.length,
  };
}
