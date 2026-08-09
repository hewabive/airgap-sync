import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import semver from 'semver';
import type {
  BundleManifest,
  DistTagsManifest,
  PackageMetadata,
  PublishActionResult,
  PublishReport,
  PublishTimings,
  TagRequirement,
} from '../types.js';
import { encodePackageName, isBlockedPublishRegistry } from './registry.js';
import * as fs from './fs.js';
import { throwIfInvalidBundle, validateBundle } from './validation.js';
import { assertNpmSecurityGate } from './security.js';

const execFileAsync = promisify(execFile);
const defaultDistTagConcurrency = 4;
const defaultPublishConcurrency = 4;
const tempPublishTag = 'airgap-sync-temp';
const registryLookupConcurrency = 8;

interface NpmRunOptions {
  maxBuffer: number;
  timeout: number;
}

export type NpmRunner = (
  args: string[],
  options: NpmRunOptions
) => Promise<{ stdout: string; stderr?: string }>;

export interface PublishBundleOptions {
  /** Explicit compatibility escape hatch for schemaVersion 1 bundles. */
  allowLegacyBundle?: boolean;
  bundleDir: string;
  distTagConcurrency?: number;
  dryRun?: boolean;
  onProgress?: (event: PublishProgressEvent) => void;
  publishConcurrency?: number;
  registryUrl: string;
  runNpm?: NpmRunner;
  skipExisting?: boolean;
}

export type PublishProgressPhase =
  | 'auth'
  | 'cleanup'
  | 'dist-tags'
  | 'dry-run'
  | 'lookup-metadata'
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

interface PackageRegistrySnapshot {
  distTags: Record<string, string>;
  versions: Set<string>;
}

interface NpmViewPackageSnapshot {
  'dist-tags'?: unknown;
  distTags?: unknown;
  versions?: unknown;
}

type ManifestPackage = BundleManifest['packages'][number];

interface DistTagResult {
  error?: string;
  package: string;
  status: 'skipped' | 'tagged' | 'error';
  tag: string;
}

interface PublishPackageResult {
  error?: string;
  package: string;
  packageName: string;
  status: 'published' | 'skipped' | 'error';
}

const emptyPackageSnapshot = (): PackageRegistrySnapshot => ({
  distTags: {},
  versions: new Set(),
});

function createPublishTimings(): PublishTimings {
  return {
    cleanupMs: 0,
    distTagsMs: 0,
    dryRunMs: 0,
    lookupMetadataMs: 0,
    publishMs: 0,
    totalMs: 0,
    validateMs: 0,
  };
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

function normalizeConcurrency(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function packageId(pkg: { name: string; version: string }): string {
  return `${pkg.name}@${pkg.version}`;
}

function compareVersions(left: string, right: string): number {
  if (semver.valid(left) && semver.valid(right)) {
    return semver.compare(left, right);
  }

  return left.localeCompare(right);
}

function isBundledLatestRequirement(requirement: TagRequirement): boolean {
  return requirement.tag === 'latest' && requirement.requiredBy === 'airgap-sync:bundled-latest';
}

function shouldKeepCurrentBundledLatest(
  requirement: TagRequirement,
  currentVersion: string | undefined
): boolean {
  return (
    isBundledLatestRequirement(requirement) &&
    currentVersion !== undefined &&
    semver.valid(currentVersion) !== null &&
    semver.valid(requirement.version) !== null &&
    semver.gt(currentVersion, requirement.version)
  );
}

function groupByPackageName<T extends { name: string }>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.name);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.name, [item]);
    }
  }

  return [...groups.values()];
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('409') ||
    message.toLowerCase().includes('conflict') ||
    message.includes('cannot publish over')
  );
}

function parseNpmJsonError(output: string): string | undefined {
  const startMatch = /\{\s*"error"\s*:/u.exec(output);

  if (!startMatch) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  const start = startMatch.index;

  for (let index = start; index < output.length; index++) {
    const char = output[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth++;
      continue;
    }

    if (char !== '}') {
      continue;
    }

    depth--;
    if (depth !== 0) {
      continue;
    }

    const parsed = JSON.parse(output.slice(start, index + 1)) as {
      error?: {
        detail?: unknown;
        summary?: unknown;
      };
    };
    const summary = typeof parsed.error?.summary === 'string' ? parsed.error.summary.trim() : '';
    const detail = typeof parsed.error?.detail === 'string' ? parsed.error.detail.trim() : '';
    return [summary, detail].filter((part) => part.length > 0).join('\n') || undefined;
  }

  return undefined;
}

function errorSummary(error: unknown): string {
  const stderr =
    error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
  const stdout =
    error && typeof error === 'object' && 'stdout' in error ? String(error.stdout).trim() : '';
  const message = error instanceof Error ? error.message : String(error);
  const jsonSummary = parseNpmJsonError([stderr, stdout, message].join('\n'));

  if (jsonSummary) {
    return jsonSummary;
  }

  const lines = [stderr, stdout, message]
    .filter((part) => part.length > 0)
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const meaningfulLines = lines.filter(
    (line) => !line.startsWith('npm notice') && !line.startsWith('Command failed:')
  );
  const firstNpmError = meaningfulLines.find((line) => /^npm (?:error|ERR!)/u.test(line));
  const summaryLines = [...new Set(firstNpmError ? [firstNpmError] : meaningfulLines)].slice(0, 8);
  const summary =
    summaryLines.length > 0 ? summaryLines.join('\n') : (lines.at(-1) ?? 'Unknown error');

  if (summary.includes('E413') || /payload too large/iu.test(summary)) {
    return `${summary} (target registry rejected the upload as too large; raise Verdaccio max_body_size and any reverse-proxy upload limit)`;
  }

  return summary;
}

async function findNpmCliPath(): Promise<string | undefined> {
  const execPath = process.env.npm_execpath;

  if (execPath && path.basename(execPath).toLowerCase() === 'npm-cli.js') {
    return execPath;
  }

  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(
      path.dirname(path.dirname(process.execPath)),
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    ),
  ];

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function runNpm(args: string[], options: NpmRunOptions): Promise<{ stdout: string }> {
  const npmCliPath = await findNpmCliPath();

  if (npmCliPath) {
    return await execFileAsync(process.execPath, [npmCliPath, ...args], {
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
      windowsHide: true,
    });
  }

  if (process.platform === 'win32') {
    throw new Error(
      'Could not locate npm-cli.js next to the current Node.js executable. Install Node.js with npm, or run airgap-sync through npm/npx so npm_execpath is available.'
    );
  }

  return await execFileAsync('npm', args, {
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    windowsHide: true,
  });
}

async function runNpmCommand(
  args: string[],
  options: NpmRunOptions,
  runner?: NpmRunner
): Promise<{ stdout: string; stderr?: string }> {
  return runner ? await runner(args, options) : await runNpm(args, options);
}

function bundledLatestRequirements(
  manifest: BundleManifest,
  distTags: DistTagsManifest
): TagRequirement[] {
  const namesWithLatest = new Set(
    distTags.requirements
      .filter((requirement) => requirement.tag === 'latest')
      .map((requirement) => requirement.name)
  );
  const latestByName = new Map<string, string>();

  for (const pkg of manifest.packages) {
    if (namesWithLatest.has(pkg.name)) {
      continue;
    }

    const current = latestByName.get(pkg.name);
    if (!current || compareVersions(current, pkg.version) < 0) {
      latestByName.set(pkg.name, pkg.version);
    }
  }

  return [...latestByName]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, version]) => ({
      name,
      requiredBy: 'airgap-sync:bundled-latest',
      tag: 'latest',
      version,
    }));
}

async function npmPublish(
  tarballPath: string,
  registryUrl: string,
  runner?: NpmRunner
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-publish-'));
  const stagedTarballPath = path.join(tempDir, path.basename(tarballPath));

  try {
    await fs.copyFile(tarballPath, stagedTarballPath);
    await runNpmCommand(
      [
        'publish',
        stagedTarballPath,
        '--registry',
        registryUrl,
        '--tag',
        tempPublishTag,
        '--provenance',
        'false',
        '--json',
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 300_000 },
      runner
    );
  } finally {
    await fs.remove(tempDir);
  }
}

async function npmWhoami(registryUrl: string, runner?: NpmRunner): Promise<void> {
  await runNpmCommand(
    ['whoami', '--registry', registryUrl],
    { maxBuffer: 1024 * 1024, timeout: 30_000 },
    runner
  );
}

function npmAuthError(registryUrl: string, error: unknown): PublishActionResult {
  return {
    action: 'auth',
    error: [
      `npm is not logged in to ${registryUrl}.`,
      `Existing user: npm login --registry ${registryUrl}`,
      `New user: npm adduser --registry ${registryUrl}`,
      errorSummary(error),
    ]
      .filter(Boolean)
      .join('\n'),
    package: registryUrl,
    status: 'error',
  };
}

async function npmDistTagAdd(
  requirement: TagRequirement,
  registryUrl: string,
  runner?: NpmRunner
): Promise<void> {
  await runNpmCommand(
    [
      'dist-tag',
      'add',
      `${requirement.name}@${requirement.version}`,
      requirement.tag,
      '--registry',
      registryUrl,
    ],
    { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
    runner
  );
}

async function npmDistTagRemove(
  packageName: string,
  tag: string,
  registryUrl: string,
  runner?: NpmRunner
): Promise<void> {
  await runNpmCommand(
    ['dist-tag', 'rm', packageName, tag, '--registry', registryUrl],
    {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    },
    runner
  );
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

function packageSnapshotFromMetadata(metadata: PackageMetadata): PackageRegistrySnapshot {
  return {
    distTags: metadata['dist-tags'] ?? {},
    versions: new Set(Object.keys(metadata.versions)),
  };
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  return typeof value === 'string' ? [value] : [];
}

function parseDistTags(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function parseNpmViewPackageSnapshot(stdout: string): PackageRegistrySnapshot {
  if (!stdout.trim()) {
    return emptyPackageSnapshot();
  }

  const parsed = JSON.parse(stdout) as NpmViewPackageSnapshot;
  return {
    distTags: parseDistTags(parsed['dist-tags'] ?? parsed.distTags),
    versions: new Set(parseStringList(parsed.versions)),
  };
}

async function fetchPackageSnapshot(
  packageName: string,
  registryUrl: string
): Promise<PackageRegistrySnapshot> {
  const response = await fetch(
    `${registryUrl.replace(/\/$/, '')}/${encodePackageName(packageName)}`,
    {
      headers: {
        Accept: 'application/vnd.npm.install-v1+json, application/json',
      },
      signal: AbortSignal.timeout(30_000),
    }
  );

  if (response.status === 404) {
    return emptyPackageSnapshot();
  }

  if (response.status !== 200) {
    throw new Error(`Package metadata request failed with status ${String(response.status)}`);
  }

  return packageSnapshotFromMetadata((await response.json()) as PackageMetadata);
}

async function npmPackageSnapshotFromCli(
  packageName: string,
  registryUrl: string,
  runner?: NpmRunner
): Promise<PackageRegistrySnapshot> {
  try {
    const { stdout } = await runNpmCommand(
      ['view', packageName, 'versions', 'dist-tags', '--json', '--registry', registryUrl],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
      runner
    );
    return parseNpmViewPackageSnapshot(stdout);
  } catch {
    return emptyPackageSnapshot();
  }
}

async function npmPackageSnapshot(
  packageName: string,
  registryUrl: string,
  runner?: NpmRunner
): Promise<PackageRegistrySnapshot> {
  try {
    return await fetchPackageSnapshot(packageName, registryUrl);
  } catch {
    return npmPackageSnapshotFromCli(packageName, registryUrl, runner);
  }
}

async function lookupPackageSnapshots(
  manifest: BundleManifest,
  distTags: DistTagsManifest,
  registryUrl: string,
  runner?: NpmRunner,
  onProgress?: PublishBundleOptions['onProgress']
): Promise<Map<string, PackageRegistrySnapshot>> {
  const packageNames = [
    ...new Set([
      ...manifest.packages.map((pkg) => pkg.name),
      ...distTags.requirements.map((requirement) => requirement.name),
    ]),
  ];
  let completed = 0;
  onProgress?.({
    current: 0,
    phase: 'lookup-metadata',
    status: 'start',
    total: packageNames.length,
  });
  const entries = await mapWithConcurrency(
    packageNames,
    registryLookupConcurrency,
    async (name) => {
      const result = [name, await npmPackageSnapshot(name, registryUrl, runner)] as const;
      completed++;
      onProgress?.({
        current: completed,
        package: name,
        phase: 'lookup-metadata',
        status: 'progress',
        total: packageNames.length,
      });
      return result;
    }
  );
  onProgress?.({
    current: packageNames.length,
    phase: 'lookup-metadata',
    status: 'done',
    total: packageNames.length,
  });

  return new Map(entries);
}

export function createPublishPlan(
  manifest: BundleManifest,
  distTags: DistTagsManifest
): PublishActionResult[] {
  const tagRequirements = [
    ...distTags.requirements,
    ...bundledLatestRequirements(manifest, distTags),
  ];
  return [
    ...manifest.packages.map((pkg) => ({
      action: 'publish' as const,
      package: packageId(pkg),
      status: 'planned' as const,
    })),
    ...tagRequirements.map((requirement) => ({
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

  const totalStart = performance.now();
  const timings = createPublishTimings();

  const validateStart = performance.now();
  options.onProgress?.({ phase: 'validate', status: 'start' });
  if (options.allowLegacyBundle !== true) {
    await assertNpmSecurityGate(options.bundleDir, manifest);
  }
  throwIfInvalidBundle(await validateBundle(options.bundleDir, manifest, distTags));
  options.onProgress?.({ phase: 'validate', status: 'done' });
  timings.validateMs = elapsedMs(validateStart);

  const errors: PublishActionResult[] = [];
  let published = 0;
  let skipped = 0;
  let restoredTags = 0;
  const tagRequirements = [
    ...distTags.requirements,
    ...bundledLatestRequirements(manifest, distTags),
  ];

  if (options.dryRun) {
    const dryRunStart = performance.now();
    const plan = createPublishPlan(manifest, distTags);
    options.onProgress?.({
      current: plan.length,
      phase: 'dry-run',
      status: 'planned',
      total: plan.length,
    });
    timings.dryRunMs = elapsedMs(dryRunStart);
    timings.totalMs = elapsedMs(totalStart);
    return {
      dryRun: true,
      errors: [],
      generatedAt: new Date().toISOString(),
      published: plan.filter((item) => item.action === 'publish').length,
      registry: options.registryUrl,
      restoredTags: plan.filter((item) => item.action === 'dist-tag').length,
      skipped: 0,
      timings,
      totalPackages: manifest.packages.length,
    };
  }

  const lookupMetadataStart = performance.now();
  const packageSnapshots =
    options.skipExisting === false
      ? new Map<string, PackageRegistrySnapshot>()
      : await lookupPackageSnapshots(
          manifest,
          distTags,
          options.registryUrl,
          options.runNpm,
          options.onProgress
        );
  const existingVersionsByPackage = new Map(
    [...packageSnapshots].map(([name, snapshot]) => [name, snapshot.versions] as const)
  );
  const currentDistTags = new Map(
    [...packageSnapshots].map(([name, snapshot]) => [name, snapshot.distTags] as const)
  );
  const publishedPackageNames = new Set<string>();
  timings.lookupMetadataMs = elapsedMs(lookupMetadataStart);

  const needsAuth =
    manifest.packages.some((pkg) => !existingVersionsByPackage.get(pkg.name)?.has(pkg.version)) ||
    tagRequirements.some((requirement) => {
      const currentVersion = currentDistTags.get(requirement.name)?.[requirement.tag];
      return (
        currentVersion !== requirement.version &&
        !shouldKeepCurrentBundledLatest(requirement, currentVersion)
      );
    });

  if (needsAuth) {
    options.onProgress?.({ phase: 'auth', status: 'start' });
    try {
      await npmWhoami(options.registryUrl, options.runNpm);
      options.onProgress?.({ phase: 'auth', status: 'done' });
    } catch (error) {
      options.onProgress?.({ phase: 'auth', status: 'error' });
      timings.totalMs = elapsedMs(totalStart);
      return {
        dryRun: false,
        errors: [npmAuthError(options.registryUrl, error)],
        generatedAt: new Date().toISOString(),
        published: 0,
        registry: options.registryUrl,
        restoredTags: 0,
        skipped: 0,
        timings,
        totalPackages: manifest.packages.length,
      };
    }
  }

  const publishStart = performance.now();
  const publishConcurrency = normalizeConcurrency(
    options.publishConcurrency,
    defaultPublishConcurrency
  );
  let publishProgress = 0;
  options.onProgress?.({
    current: publishProgress,
    phase: 'publish',
    status: 'start',
    total: manifest.packages.length,
  });

  async function publishPackage(pkg: ManifestPackage): Promise<PublishPackageResult> {
    const id = packageId(pkg);

    if (existingVersionsByPackage.get(pkg.name)?.has(pkg.version)) {
      publishProgress++;
      options.onProgress?.({
        current: publishProgress,
        package: id,
        phase: 'publish',
        status: 'skipped',
        total: manifest.packages.length,
      });
      return {
        package: id,
        packageName: pkg.name,
        status: 'skipped',
      };
    }

    try {
      await npmPublish(path.join(options.bundleDir, pkg.file), options.registryUrl, options.runNpm);
      publishProgress++;
      options.onProgress?.({
        current: publishProgress,
        package: id,
        phase: 'publish',
        status: 'published',
        total: manifest.packages.length,
      });
      return {
        package: id,
        packageName: pkg.name,
        status: 'published',
      };
    } catch (error) {
      if (options.skipExisting !== false && isAlreadyExistsError(error)) {
        publishProgress++;
        options.onProgress?.({
          current: publishProgress,
          package: id,
          phase: 'publish',
          status: 'skipped',
          total: manifest.packages.length,
        });
        return {
          package: id,
          packageName: pkg.name,
          status: 'skipped',
        };
      }

      if (options.skipExisting !== false) {
        try {
          const snapshot = await npmPackageSnapshot(pkg.name, options.registryUrl, options.runNpm);
          if (snapshot.versions.has(pkg.version)) {
            existingVersionsByPackage.set(pkg.name, snapshot.versions);
            currentDistTags.set(pkg.name, snapshot.distTags);
            publishProgress++;
            options.onProgress?.({
              current: publishProgress,
              package: id,
              phase: 'publish',
              status: 'skipped',
              total: manifest.packages.length,
            });
            return {
              package: id,
              packageName: pkg.name,
              status: 'skipped',
            };
          }
        } catch {
          // Keep the original npm publish failure; the follow-up lookup is only a recovery path.
        }
      }

      publishProgress++;
      options.onProgress?.({
        current: publishProgress,
        package: id,
        phase: 'publish',
        status: 'error',
        total: manifest.packages.length,
      });
      return {
        error: errorSummary(error),
        package: id,
        packageName: pkg.name,
        status: 'error',
      };
    }
  }

  const publishResultGroups = await mapWithConcurrency(
    groupByPackageName(manifest.packages),
    publishConcurrency,
    async (group) => {
      const results: PublishPackageResult[] = [];
      for (const pkg of group) {
        results.push(await publishPackage(pkg));
      }
      return results;
    }
  );
  const publishResults = publishResultGroups.flat();
  for (const result of publishResults) {
    if (result.status === 'published') {
      published++;
      publishedPackageNames.add(result.packageName);
    } else if (result.status === 'skipped') {
      skipped++;
    } else {
      errors.push({
        action: 'publish',
        package: result.package,
        status: 'error',
        error: result.error ?? 'Unknown error',
      });
    }
  }
  options.onProgress?.({
    current: publishProgress,
    phase: 'publish',
    status: 'done',
    total: manifest.packages.length,
  });
  timings.publishMs = elapsedMs(publishStart);

  const distTagsStart = performance.now();
  const distTagConcurrency = normalizeConcurrency(
    options.distTagConcurrency,
    defaultDistTagConcurrency
  );
  let tagProgress = 0;
  options.onProgress?.({
    current: tagProgress,
    phase: 'dist-tags',
    status: 'start',
    total: tagRequirements.length,
  });

  async function restoreDistTag(requirement: TagRequirement): Promise<DistTagResult> {
    const currentVersion = currentDistTags.get(requirement.name)?.[requirement.tag];
    if (
      currentVersion === requirement.version ||
      shouldKeepCurrentBundledLatest(requirement, currentVersion)
    ) {
      tagProgress++;
      options.onProgress?.({
        current: tagProgress,
        package: packageId(requirement),
        phase: 'dist-tags',
        status: 'skipped',
        tag: requirement.tag,
        total: tagRequirements.length,
      });
      return {
        package: packageId(requirement),
        status: 'skipped',
        tag: requirement.tag,
      };
    }

    try {
      await npmDistTagAdd(requirement, options.registryUrl, options.runNpm);
      const packageTags = currentDistTags.get(requirement.name) ?? {};
      packageTags[requirement.tag] = requirement.version;
      currentDistTags.set(requirement.name, packageTags);
      tagProgress++;
      options.onProgress?.({
        current: tagProgress,
        package: packageId(requirement),
        phase: 'dist-tags',
        status: 'tagged',
        tag: requirement.tag,
        total: tagRequirements.length,
      });
      return {
        package: packageId(requirement),
        status: 'tagged',
        tag: requirement.tag,
      };
    } catch (error) {
      tagProgress++;
      options.onProgress?.({
        current: tagProgress,
        package: packageId(requirement),
        phase: 'dist-tags',
        status: 'error',
        tag: requirement.tag,
        total: tagRequirements.length,
      });
      return {
        error: errorSummary(error),
        package: packageId(requirement),
        status: 'error',
        tag: requirement.tag,
      };
    }
  }

  const distTagResultGroups = await mapWithConcurrency(
    groupByPackageName(tagRequirements),
    distTagConcurrency,
    async (group) => {
      const results: DistTagResult[] = [];
      for (const requirement of group) {
        results.push(await restoreDistTag(requirement));
      }
      return results;
    }
  );
  for (const result of distTagResultGroups.flat()) {
    if (result.status === 'tagged' || result.status === 'skipped') {
      restoredTags++;
    } else {
      errors.push({
        action: 'dist-tag',
        package: result.package,
        status: 'error',
        tag: result.tag,
        error: result.error ?? 'Unknown error',
      });
    }
  }
  options.onProgress?.({
    current: tagProgress,
    phase: 'dist-tags',
    status: 'done',
    total: tagRequirements.length,
  });
  timings.distTagsMs = elapsedMs(distTagsStart);

  const cleanupStart = performance.now();
  let cleanupProgress = 0;
  const cleanupTotal = publishedPackageNames.size;
  options.onProgress?.({
    current: cleanupProgress,
    phase: 'cleanup',
    status: 'start',
    total: cleanupTotal,
  });
  await mapWithConcurrency([...publishedPackageNames], distTagConcurrency, async (packageName) => {
    try {
      await npmDistTagRemove(packageName, tempPublishTag, options.registryUrl, options.runNpm);
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
  });
  options.onProgress?.({
    current: cleanupProgress,
    phase: 'cleanup',
    status: 'done',
    total: cleanupTotal,
  });
  timings.cleanupMs = elapsedMs(cleanupStart);

  timings.totalMs = elapsedMs(totalStart);
  return {
    dryRun: false,
    errors,
    generatedAt: new Date().toISOString(),
    published,
    registry: options.registryUrl,
    restoredTags,
    skipped,
    timings,
    totalPackages: manifest.packages.length,
  };
}
