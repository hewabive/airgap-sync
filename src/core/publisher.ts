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
const tempPublishTag = 'airgap-sync-temp';
const registryLookupConcurrency = 8;

export interface PublishBundleOptions {
  bundleDir: string;
  dryRun?: boolean;
  onProgress?: (event: PublishProgressEvent) => void;
  registryUrl: string;
  skipExisting?: boolean;
}

export type PublishProgressPhase =
  | 'cleanup'
  | 'dist-tags'
  | 'dry-run'
  | 'lookup-tags'
  | 'lookup-versions'
  | 'publish'
  | 'validate';

export type PublishProgressStatus =
  | 'done'
  | 'error'
  | 'planned'
  | 'progress'
  | 'published'
  | 'skipped'
  | 'start'
  | 'tagged';

export interface PublishProgressEvent {
  phase: PublishProgressPhase;
  status: PublishProgressStatus;
  current?: number;
  package?: string;
  tag?: string;
  total?: number;
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

export function packageNamesMissingLatestTags(
  manifest: BundleManifest,
  distTags: DistTagsManifest
): string[] {
  const packageNames = new Set(manifest.packages.map((pkg) => pkg.name));
  const namesWithLatest = new Set(
    distTags.requirements
      .filter((requirement) => requirement.tag === 'latest')
      .map((requirement) => requirement.name)
  );

  return [...packageNames].filter((name) => !namesWithLatest.has(name));
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

function parseNpmJsonList(stdout: string): string[] {
  if (!stdout.trim()) {
    return [];
  }

  const parsed = JSON.parse(stdout) as string | string[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseNpmJsonObject(stdout: string): Record<string, string> {
  if (!stdout.trim()) {
    return {};
  }

  const parsed = JSON.parse(stdout) as Record<string, string>;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      const item = items[currentIndex];
      if (item === undefined) {
        continue;
      }

      results[currentIndex] = await mapper(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => worker())
  );
  return results;
}

async function npmPackageVersions(packageName: string, registryUrl: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['view', packageName, 'versions', '--json', '--registry', registryUrl],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      }
    );
    return parseNpmJsonList(stdout);
  } catch {
    return [];
  }
}

async function npmPackageDistTags(
  packageName: string,
  registryUrl: string
): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['view', packageName, 'dist-tags', '--json', '--registry', registryUrl],
      {
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      }
    );
    return parseNpmJsonObject(stdout);
  } catch {
    return {};
  }
}

async function lookupExistingVersions(
  manifest: BundleManifest,
  registryUrl: string,
  onProgress?: PublishBundleOptions['onProgress']
): Promise<Map<string, Set<string>>> {
  const packageNames = [...new Set(manifest.packages.map((pkg) => pkg.name))];
  let completed = 0;
  onProgress?.({
    current: 0,
    phase: 'lookup-versions',
    status: 'start',
    total: packageNames.length,
  });
  const entries = await mapWithConcurrency(
    packageNames,
    registryLookupConcurrency,
    async (name) => {
      const result = [name, new Set(await npmPackageVersions(name, registryUrl))] as const;
      completed++;
      onProgress?.({
        current: completed,
        package: name,
        phase: 'lookup-versions',
        status: 'progress',
        total: packageNames.length,
      });
      return result;
    }
  );
  onProgress?.({
    current: packageNames.length,
    phase: 'lookup-versions',
    status: 'done',
    total: packageNames.length,
  });

  return new Map(entries);
}

async function lookupCurrentDistTags(
  distTags: DistTagsManifest,
  registryUrl: string,
  onProgress?: PublishBundleOptions['onProgress']
): Promise<Map<string, Record<string, string>>> {
  const packageNames = [...new Set(distTags.requirements.map((requirement) => requirement.name))];
  let completed = 0;
  onProgress?.({
    current: 0,
    phase: 'lookup-tags',
    status: 'start',
    total: packageNames.length,
  });
  const entries = await mapWithConcurrency(
    packageNames,
    registryLookupConcurrency,
    async (name) => {
      const result = [name, await npmPackageDistTags(name, registryUrl)] as const;
      completed++;
      onProgress?.({
        current: completed,
        package: name,
        phase: 'lookup-tags',
        status: 'progress',
        total: packageNames.length,
      });
      return result;
    }
  );
  onProgress?.({
    current: packageNames.length,
    phase: 'lookup-tags',
    status: 'done',
    total: packageNames.length,
  });

  return new Map(entries);
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

  options.onProgress?.({ phase: 'validate', status: 'start' });
  throwIfInvalidBundle(await validateBundle(options.bundleDir, manifest, distTags));
  options.onProgress?.({ phase: 'validate', status: 'done' });

  const errors: PublishActionResult[] = [];
  let published = 0;
  let skipped = 0;
  let restoredTags = 0;

  if (options.dryRun) {
    const plan = createPublishPlan(manifest, distTags);
    options.onProgress?.({
      current: plan.length,
      phase: 'dry-run',
      status: 'planned',
      total: plan.length,
    });
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

  const existingPackageNames = new Set<string>();
  const existingVersionsByPackage =
    options.skipExisting === false
      ? new Map<string, Set<string>>()
      : await lookupExistingVersions(manifest, options.registryUrl, options.onProgress);
  const currentDistTags =
    options.skipExisting === false
      ? new Map<string, Record<string, string>>()
      : await lookupCurrentDistTags(distTags, options.registryUrl, options.onProgress);
  const publishedPackageNames = new Set<string>();

  const packageNamesWithoutLatest = packageNamesMissingLatestTags(manifest, distTags);
  for (const packageName of packageNamesWithoutLatest) {
    if (existingPackageNames.has(packageName)) {
      continue;
    }

    const existingVersions = existingVersionsByPackage.get(packageName);
    if (
      (existingVersions && existingVersions.size > 0) ||
      (await npmPackageNameExists(packageName, options.registryUrl))
    ) {
      existingPackageNames.add(packageName);
    }
  }

  const missingLatest = packageNamesWithoutLatest.filter((name) => !existingPackageNames.has(name));

  if (missingLatest.length > 0) {
    throw new Error(
      [
        'Bundle is missing upstream latest tags for packages that do not exist in the target registry.',
        'Regenerate the bundle with a current airgap-sync fetch command.',
        `Packages: ${missingLatest.join(', ')}`,
      ].join(' ')
    );
  }

  let publishProgress = 0;
  options.onProgress?.({
    current: publishProgress,
    phase: 'publish',
    status: 'start',
    total: manifest.packages.length,
  });
  for (const pkg of manifest.packages) {
    if (existingVersionsByPackage.get(pkg.name)?.has(pkg.version)) {
      skipped++;
      publishProgress++;
      options.onProgress?.({
        current: publishProgress,
        package: packageId(pkg),
        phase: 'publish',
        status: 'skipped',
        total: manifest.packages.length,
      });
      continue;
    }

    try {
      await npmPublish(path.join(options.bundleDir, pkg.file), options.registryUrl);
      published++;
      publishedPackageNames.add(pkg.name);
      publishProgress++;
      options.onProgress?.({
        current: publishProgress,
        package: packageId(pkg),
        phase: 'publish',
        status: 'published',
        total: manifest.packages.length,
      });
    } catch (error) {
      if (options.skipExisting !== false && isAlreadyExistsError(error)) {
        skipped++;
        publishProgress++;
        options.onProgress?.({
          current: publishProgress,
          package: packageId(pkg),
          phase: 'publish',
          status: 'skipped',
          total: manifest.packages.length,
        });
        continue;
      }

      publishProgress++;
      options.onProgress?.({
        current: publishProgress,
        package: packageId(pkg),
        phase: 'publish',
        status: 'error',
        total: manifest.packages.length,
      });
      errors.push({
        action: 'publish',
        package: packageId(pkg),
        status: 'error',
        error: errorSummary(error),
      });
    }
  }
  options.onProgress?.({
    current: publishProgress,
    phase: 'publish',
    status: 'done',
    total: manifest.packages.length,
  });

  if (errors.length === 0) {
    let tagProgress = 0;
    options.onProgress?.({
      current: tagProgress,
      phase: 'dist-tags',
      status: 'start',
      total: distTags.requirements.length,
    });
    for (const requirement of distTags.requirements) {
      if (currentDistTags.get(requirement.name)?.[requirement.tag] === requirement.version) {
        restoredTags++;
        tagProgress++;
        options.onProgress?.({
          current: tagProgress,
          package: packageId(requirement),
          phase: 'dist-tags',
          status: 'skipped',
          tag: requirement.tag,
          total: distTags.requirements.length,
        });
        continue;
      }

      try {
        await npmDistTagAdd(requirement, options.registryUrl);
        restoredTags++;
        tagProgress++;
        options.onProgress?.({
          current: tagProgress,
          package: packageId(requirement),
          phase: 'dist-tags',
          status: 'tagged',
          tag: requirement.tag,
          total: distTags.requirements.length,
        });
      } catch (error) {
        tagProgress++;
        options.onProgress?.({
          current: tagProgress,
          package: packageId(requirement),
          phase: 'dist-tags',
          status: 'error',
          tag: requirement.tag,
          total: distTags.requirements.length,
        });
        errors.push({
          action: 'dist-tag',
          package: packageId(requirement),
          status: 'error',
          tag: requirement.tag,
          error: errorSummary(error),
        });
      }
    }
    options.onProgress?.({
      current: tagProgress,
      phase: 'dist-tags',
      status: 'done',
      total: distTags.requirements.length,
    });

    let cleanupProgress = 0;
    const cleanupTotal = publishedPackageNames.size;
    options.onProgress?.({
      current: cleanupProgress,
      phase: 'cleanup',
      status: 'start',
      total: cleanupTotal,
    });
    for (const packageName of publishedPackageNames) {
      try {
        await npmDistTagRemove(packageName, tempPublishTag, options.registryUrl);
      } catch {
        // The temp tag may already be absent if the package existed before this run.
      }
      cleanupProgress++;
      options.onProgress?.({
        current: cleanupProgress,
        package: packageName,
        phase: 'cleanup',
        status: 'progress',
        total: cleanupTotal,
      });
    }
    options.onProgress?.({
      current: cleanupProgress,
      phase: 'cleanup',
      status: 'done',
      total: cleanupTotal,
    });
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
