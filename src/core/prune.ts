import path from 'node:path';
import * as fs from './fs.js';
import type {
  BundleManifest,
  BundlePruneActionResult,
  BundlePruneObjectSummary,
  BundlePruneObjectType,
  BundlePruneReport,
  CollectReport,
  GitSourcesManifest,
} from '../types.js';
import { readPythonSeedManifest } from './python/bundle.js';
import {
  readPythonApplicationBundleIndex,
  type PythonApplicationBundleIndex,
} from './python/application-bundle.js';
import {
  pythonApplicationPlanDirectory,
  pythonApplicationsDirectory,
  pythonOptionalArtifactsDirectory,
  pythonWheelArtifactsDirectory,
} from './python/application-paths.js';
import {
  cpythonDistributionArtifactsDirectory,
  readCpythonDistributionBundleIndex,
  type CpythonDistributionBundleIndex,
} from './python/distribution-bundle.js';

export interface PruneBundleOptions {
  bundleDir: string;
  dryRun?: boolean;
  generatedAt?: string;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function relativePosix(root: string, itemPath: string): string {
  return toPosixPath(path.relative(root, itemPath));
}

function successfulCollectReport(report: CollectReport): boolean {
  return (
    !report.dryRun &&
    report.fixedPoint &&
    report.wroteBundle &&
    !report.maxIterationsReached &&
    report.repositoryUpdate.errors.length === 0 &&
    report.fetch.errors.length === 0 &&
    (report.python?.errors.length ?? 0) === 0 &&
    (report.pythonApplications?.errors.length ?? 0) === 0 &&
    (report.cpythonDistributions?.errors.length ?? 0) === 0 &&
    report.gitSources.skipped.length === 0 &&
    report.gitFetch.errors.length === 0 &&
    report.gitManifestScanErrors.length === 0
  );
}

async function readRequiredJson<T>(filePath: string, description: string): Promise<T> {
  try {
    return await fs.readJson<T>(filePath);
  } catch (error) {
    throw new Error(`${description} is missing or unreadable: ${(error as Error).message}`);
  }
}

function ensureRelativePath(value: string, description: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new Error(`${description} must be a bundle-relative path: ${value}`);
  }
  return normalized;
}

async function listPackageFiles(bundleDir: string): Promise<string[]> {
  const packageDir = path.join(bundleDir, 'packages');
  try {
    const entries = await fs.readdir(packageDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
      .map((entry) => path.posix.join('packages', entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function listPythonPackageFiles(bundleDir: string): Promise<string[]> {
  const packageDir = path.join(bundleDir, 'python-packages');
  try {
    const entries = await fs.readdir(packageDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.whl'))
      .map((entry) => path.posix.join('python-packages', entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function listFilesRecursively(
  bundleDir: string,
  relativeDirectory: string
): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(path.join(bundleDir, directory), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const relativePath = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  await walk(relativeDirectory);
  return files.sort();
}

async function listPythonApplicationPlanDirectories(bundleDir: string): Promise<string[]> {
  try {
    return (
      await fs.readdir(path.join(bundleDir, pythonApplicationsDirectory), {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.posix.join(pythonApplicationsDirectory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function listPythonApplicationArtifactDirectories(bundleDir: string): Promise<string[]> {
  const directories: string[] = [];
  for (const artifactRoot of [pythonOptionalArtifactsDirectory, pythonWheelArtifactsDirectory]) {
    try {
      const entries = await fs.readdir(path.join(bundleDir, artifactRoot), {
        withFileTypes: true,
      });
      directories.push(
        ...entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.posix.join(artifactRoot, entry.name))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return directories.sort();
}

async function listGitMirrorDirs(bundleDir: string): Promise<string[]> {
  const mirrorsDir = path.join(bundleDir, 'git-mirrors');
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(dir, entry.name);
      if (entry.name.endsWith('.git')) {
        found.push(relativePosix(bundleDir, entryPath));
        continue;
      }

      await walk(entryPath);
    }
  }

  await walk(mirrorsDir);
  return found.sort();
}

function summary(total: number, stale: number, removed: number): BundlePruneObjectSummary {
  return {
    kept: total - stale,
    removed,
    stale,
    total,
  };
}

function createAction(
  type: BundlePruneObjectType,
  relativePath: string,
  dryRun: boolean
): BundlePruneActionResult {
  return {
    path: relativePath,
    status: dryRun ? 'planned' : 'removed',
    type,
  };
}

async function removeStaleObject(
  bundleDir: string,
  type: BundlePruneObjectType,
  relativePath: string,
  dryRun: boolean
): Promise<BundlePruneActionResult> {
  const normalized = ensureRelativePath(relativePath, 'stale object path');
  const absolutePath = path.resolve(bundleDir, normalized);
  const relativeToBundle = path.relative(bundleDir, absolutePath);
  if (relativeToBundle.startsWith('..') || path.isAbsolute(relativeToBundle)) {
    throw new Error(`Refusing to remove path outside bundle: ${relativePath}`);
  }

  if (!dryRun) {
    await fs.remove(absolutePath);
  }

  return createAction(type, normalized, dryRun);
}

export async function pruneBundle(options: PruneBundleOptions): Promise<BundlePruneReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const dryRun = options.dryRun === true;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const manifest = await readRequiredJson<BundleManifest>(
    path.join(bundleDir, 'seed-manifest.json'),
    'seed-manifest.json'
  );
  const gitSources = await readRequiredJson<GitSourcesManifest>(
    path.join(bundleDir, 'git-sources.json'),
    'git-sources.json'
  );
  const collectReport = await readRequiredJson<CollectReport>(
    path.join(bundleDir, 'collect-report.json'),
    'collect-report.json'
  );
  const pythonManifestPath = path.join(bundleDir, 'python-seed-manifest.json');
  const pythonManifest = (await fs.pathExists(pythonManifestPath))
    ? await readPythonSeedManifest(bundleDir).catch((error: unknown) => {
        throw new Error(
          `python-seed-manifest.json is missing or unreadable: ${(error as Error).message}`
        );
      })
    : undefined;
  let pythonApplicationIndex: PythonApplicationBundleIndex | undefined;
  try {
    pythonApplicationIndex = await readPythonApplicationBundleIndex(bundleDir);
  } catch (error) {
    throw new Error(`python/application-index.json is unreadable: ${(error as Error).message}`);
  }
  let cpythonDistributionIndex: CpythonDistributionBundleIndex | undefined;
  try {
    cpythonDistributionIndex = await readCpythonDistributionBundleIndex(bundleDir);
  } catch (error) {
    throw new Error(`python/distributions/index.json is unreadable: ${(error as Error).message}`);
  }

  if (!successfulCollectReport(collectReport)) {
    throw new Error('Refusing to prune: the last download did not complete successfully');
  }

  const livePackageFiles = new Set(
    manifest.packages.map((pkg) => ensureRelativePath(pkg.file, 'manifest package file'))
  );
  const liveGitMirrors = new Set(
    gitSources.sources.map((source) =>
      ensureRelativePath(source.localMirrorPath, 'Git source mirror path')
    )
  );
  const packageFiles = await listPackageFiles(bundleDir);
  const pythonPackageFiles = pythonManifest ? await listPythonPackageFiles(bundleDir) : [];
  const pythonApplicationArtifactFiles = await listFilesRecursively(bundleDir, 'python/artifacts');
  const cpythonDistributionFiles = await listFilesRecursively(
    bundleDir,
    cpythonDistributionArtifactsDirectory
  );
  const pythonApplicationArtifactDirectories =
    await listPythonApplicationArtifactDirectories(bundleDir);
  const pythonApplicationPlanDirectories = await listPythonApplicationPlanDirectories(bundleDir);
  const gitMirrors = await listGitMirrorDirs(bundleDir);
  const stalePackageFiles = packageFiles.filter((file) => !livePackageFiles.has(file));
  const livePythonPackageFiles = new Set(
    pythonManifest?.packages.flatMap((pkg) =>
      pkg.files.map((file) => ensureRelativePath(file.file, 'Python manifest package file'))
    ) ?? []
  );
  const stalePythonPackageFiles = pythonPackageFiles.filter(
    (file) => !livePythonPackageFiles.has(file)
  );
  const livePythonApplicationArtifacts = new Set(
    pythonApplicationIndex?.artifacts.map((artifact) =>
      ensureRelativePath(artifact.file, 'Python application artifact file')
    ) ?? []
  );
  const stalePythonApplicationArtifacts = pythonApplicationArtifactFiles.filter(
    (file) => !livePythonApplicationArtifacts.has(file)
  );
  const liveCpythonDistributions = new Set(
    cpythonDistributionIndex?.artifacts.map((artifact) =>
      ensureRelativePath(artifact.file, 'CPython distribution artifact file')
    ) ?? []
  );
  const staleCpythonDistributions = cpythonDistributionFiles.filter(
    (file) => !liveCpythonDistributions.has(file)
  );
  const stalePythonApplicationArtifactDirectories = pythonApplicationArtifactDirectories.filter(
    (directory) =>
      ![...livePythonApplicationArtifacts].some((file) => file.startsWith(`${directory}/`))
  );
  const livePythonApplicationPlans = new Set(
    pythonApplicationIndex?.applications.map((application) =>
      pythonApplicationPlanDirectory(application.targetId)
    ) ?? []
  );
  const stalePythonApplicationPlans = pythonApplicationPlanDirectories.filter(
    (directory) => !livePythonApplicationPlans.has(directory)
  );
  const staleGitMirrors = gitMirrors.filter((mirror) => !liveGitMirrors.has(mirror));
  const actions: BundlePruneActionResult[] = [];
  const errors: BundlePruneActionResult[] = [];

  for (const stalePackage of stalePackageFiles) {
    try {
      actions.push(await removeStaleObject(bundleDir, 'npm-package', stalePackage, dryRun));
    } catch (error) {
      const action: BundlePruneActionResult = {
        error: (error as Error).message,
        path: stalePackage,
        status: 'error',
        type: 'npm-package',
      };
      actions.push(action);
      errors.push(action);
    }
  }

  for (const staleGitMirror of staleGitMirrors) {
    try {
      actions.push(await removeStaleObject(bundleDir, 'git-mirror', staleGitMirror, dryRun));
    } catch (error) {
      const action: BundlePruneActionResult = {
        error: (error as Error).message,
        path: staleGitMirror,
        status: 'error',
        type: 'git-mirror',
      };
      actions.push(action);
      errors.push(action);
    }
  }

  for (const stalePythonPackage of stalePythonPackageFiles) {
    try {
      actions.push(
        await removeStaleObject(bundleDir, 'python-package', stalePythonPackage, dryRun)
      );
    } catch (error) {
      const action: BundlePruneActionResult = {
        error: (error as Error).message,
        path: stalePythonPackage,
        status: 'error',
        type: 'python-package',
      };
      actions.push(action);
      errors.push(action);
    }
  }

  for (const staleDistribution of staleCpythonDistributions) {
    try {
      actions.push(
        await removeStaleObject(bundleDir, 'cpython-distribution', staleDistribution, dryRun)
      );
    } catch (error) {
      const action: BundlePruneActionResult = {
        error: (error as Error).message,
        path: staleDistribution,
        status: 'error',
        type: 'cpython-distribution',
      };
      actions.push(action);
      errors.push(action);
    }
  }

  for (const staleArtifact of stalePythonApplicationArtifacts) {
    try {
      actions.push(
        await removeStaleObject(bundleDir, 'python-application-artifact', staleArtifact, dryRun)
      );
    } catch (error) {
      const action: BundlePruneActionResult = {
        error: (error as Error).message,
        path: staleArtifact,
        status: 'error',
        type: 'python-application-artifact',
      };
      actions.push(action);
      errors.push(action);
    }
  }

  for (const staleDirectory of stalePythonApplicationArtifactDirectories) {
    try {
      actions.push(
        await removeStaleObject(
          bundleDir,
          'python-application-artifact-directory',
          staleDirectory,
          dryRun
        )
      );
    } catch (error) {
      const action: BundlePruneActionResult = {
        error: (error as Error).message,
        path: staleDirectory,
        status: 'error',
        type: 'python-application-artifact-directory',
      };
      actions.push(action);
      errors.push(action);
    }
  }

  for (const stalePlan of stalePythonApplicationPlans) {
    try {
      actions.push(
        await removeStaleObject(bundleDir, 'python-application-plan', stalePlan, dryRun)
      );
    } catch (error) {
      const action: BundlePruneActionResult = {
        error: (error as Error).message,
        path: stalePlan,
        status: 'error',
        type: 'python-application-plan',
      };
      actions.push(action);
      errors.push(action);
    }
  }

  return {
    actions,
    bundleDir,
    dryRun,
    errors,
    generatedAt,
    cpythonDistributions: summary(
      cpythonDistributionFiles.length,
      staleCpythonDistributions.length,
      dryRun
        ? 0
        : staleCpythonDistributions.length -
            errors.filter((error) => error.type === 'cpython-distribution').length
    ),
    gitMirrors: summary(
      gitMirrors.length,
      staleGitMirrors.length,
      dryRun
        ? 0
        : staleGitMirrors.length - errors.filter((error) => error.type === 'git-mirror').length
    ),
    npmPackages: summary(
      packageFiles.length,
      stalePackageFiles.length,
      dryRun
        ? 0
        : stalePackageFiles.length - errors.filter((error) => error.type === 'npm-package').length
    ),
    pythonApplicationArtifactDirectories: summary(
      pythonApplicationArtifactDirectories.length,
      stalePythonApplicationArtifactDirectories.length,
      dryRun
        ? 0
        : stalePythonApplicationArtifactDirectories.length -
            errors.filter((error) => error.type === 'python-application-artifact-directory').length
    ),
    pythonApplicationArtifacts: summary(
      pythonApplicationArtifactFiles.length,
      stalePythonApplicationArtifacts.length,
      dryRun
        ? 0
        : stalePythonApplicationArtifacts.length -
            errors.filter((error) => error.type === 'python-application-artifact').length
    ),
    pythonApplicationPlans: summary(
      pythonApplicationPlanDirectories.length,
      stalePythonApplicationPlans.length,
      dryRun
        ? 0
        : stalePythonApplicationPlans.length -
            errors.filter((error) => error.type === 'python-application-plan').length
    ),
    pythonPackages: summary(
      pythonPackageFiles.length,
      stalePythonPackageFiles.length,
      dryRun
        ? 0
        : stalePythonPackageFiles.length -
            errors.filter((error) => error.type === 'python-package').length
    ),
    planned: actions.length,
    removed: actions.filter((action) => action.status === 'removed').length,
  };
}

export async function writePruneReport(
  bundleDir: string,
  report: BundlePruneReport
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(
    path.join(bundleDir, report.dryRun ? 'prune-dry-run-report.json' : 'prune-report.json'),
    report,
    { spaces: 2 }
  );
}
