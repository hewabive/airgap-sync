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

  return {
    actions,
    bundleDir,
    dryRun,
    errors,
    generatedAt,
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
