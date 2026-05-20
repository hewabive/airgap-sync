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

  const errors: PublishActionResult[] = [];
  let published = 0;
  let skipped = 0;
  let restoredTags = 0;

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
