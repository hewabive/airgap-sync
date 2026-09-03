import path from 'node:path';
import type { BundleManifest, GitSourcesManifest, PausedPublicationReport } from '../types.js';
import * as fs from './fs.js';
import type {
  WorkspaceCpythonDistributionsTarget,
  WorkspacePythonApplicationTarget,
  WorkspaceSnapshot,
} from './workspace.js';
import {
  type PythonApplicationBundleEntry,
  type PythonApplicationBundleIndex,
} from './python/application-bundle.js';
import type { CpythonDistributionBundleIndex } from './python/distribution-bundle.js';
import { cpythonDistributionTargetId } from './python/distribution-selection.js';
import { pythonApplicationTargetId } from './python/application-paths.js';
import { platformCoveragePolicyDigest } from './python/coverage-policy.js';
import { parseRequirement } from './python/requirements.js';

export interface PausedPublicationScope {
  cpythonArtifactIds?: ReadonlySet<string>;
  cpythonIndex?: CpythonDistributionBundleIndex;
  gitSources: GitSourcesManifest;
  npmPackageIds?: ReadonlySet<string>;
  pythonApplicationIndex?: PythonApplicationBundleIndex;
  pythonFilePaths?: ReadonlySet<string>;
  report?: PausedPublicationReport;
}

type SnapshotTarget = WorkspaceSnapshot['targets'][number];
type SnapshotGitTarget = Extract<SnapshotTarget, { type: 'git' }>;
type SnapshotNpmTarget = Extract<SnapshotTarget, { type: 'npm' }>;

export async function readOptionalWorkspaceSnapshot(
  bundleDir: string
): Promise<WorkspaceSnapshot | undefined> {
  const filePath = path.join(path.resolve(bundleDir), 'workspace-snapshot.json');
  if (!(await fs.pathExists(filePath))) return undefined;
  const value = await fs.readJson(filePath);
  if (typeof value !== 'object' || value === null || !('targets' in value)) {
    throw new Error('Invalid workspace-snapshot.json: targets must be an array');
  }
  const snapshot = value as Partial<WorkspaceSnapshot>;
  if (!Array.isArray(snapshot.targets)) {
    throw new Error('Invalid workspace-snapshot.json: targets must be an array');
  }
  return snapshot as WorkspaceSnapshot;
}

/**
 * Keep materialized target identities from the bundle while applying the current
 * workspace's operational pause flags. Target indexes are stable for pause/resume;
 * a type mismatch is left unchanged rather than risking suppression of another target.
 */
export function applyCurrentWorkspacePauses(
  bundled: WorkspaceSnapshot | undefined,
  current: WorkspaceSnapshot | undefined
): WorkspaceSnapshot | undefined {
  if (!current) return bundled;
  if (!bundled) return current;
  return {
    ...bundled,
    targets: bundled.targets.map((target, index) => {
      const currentTarget = current.targets[index];
      if (currentTarget?.type !== target.type) return target;
      const next = { ...target, ...(currentTarget.paused === true ? { paused: true } : {}) };
      if (currentTarget.paused !== true) delete next.paused;
      return next;
    }),
  };
}

function reachablePackages(seeds: ReadonlySet<string>, children: ReadonlyMap<string, Set<string>>) {
  const reachable = new Set(seeds);
  const queue = [...seeds];
  for (const parent of queue) {
    for (const child of children.get(parent) ?? []) {
      if (reachable.has(child)) continue;
      reachable.add(child);
      queue.push(child);
    }
  }
  return reachable;
}

function includedNpmPackageIds(
  manifest: BundleManifest,
  snapshot: WorkspaceSnapshot
): ReadonlySet<string> | undefined {
  const pausedSpecs = new Set(
    snapshot.targets
      .filter(
        (target): target is SnapshotNpmTarget => target.type === 'npm' && target.paused === true
      )
      .map((target) => target.spec.trim())
  );
  if (pausedSpecs.size === 0) return undefined;
  const activeSpecs = new Set(
    snapshot.targets
      .filter(
        (target): target is SnapshotNpmTarget => target.type === 'npm' && target.paused !== true
      )
      .map((target) => target.spec.trim())
  );
  for (const spec of activeSpecs) pausedSpecs.delete(spec);

  const packageId = (pkg: { name: string; version: string }) => `${pkg.name}@${pkg.version}`;
  const allPackageIds = new Set(manifest.packages.map(packageId));
  const children = new Map<string, Set<string>>();
  const pausedRoots = new Set<string>();
  const activeRoots = new Set<string>();

  for (const pkg of manifest.packages) {
    const id = packageId(pkg);
    if (pkg.resolvedFrom.length === 0) activeRoots.add(id);
    for (const reason of pkg.resolvedFrom) {
      if (reason.requiredBy === 'root') {
        if (pausedSpecs.has(reason.raw.trim())) pausedRoots.add(id);
        else activeRoots.add(id);
        continue;
      }
      if (!allPackageIds.has(reason.requiredBy)) {
        // Manifest and lockfile roots discovered in Git repositories do not carry a
        // complete workspace-target owner. Treat them as active so a pause cannot
        // accidentally make another target's dependency closure incomplete.
        activeRoots.add(id);
        continue;
      }
      const dependencies = children.get(reason.requiredBy) ?? new Set<string>();
      dependencies.add(id);
      children.set(reason.requiredBy, dependencies);
    }
  }

  const paused = reachablePackages(pausedRoots, children);
  const active = reachablePackages(activeRoots, children);
  return new Set([...allPackageIds].filter((id) => !paused.has(id) || active.has(id)));
}

function pythonApplicationScopeId(
  snapshot: WorkspaceSnapshot,
  target: WorkspacePythonApplicationTarget
): string {
  const parsed = parseRequirement(target.spec);
  if (!parsed.ok || parsed.requirement.url || parsed.requirement.marker) {
    throw new Error(`Invalid paused python-app target in workspace snapshot: ${target.spec}`);
  }
  const coverage =
    target.coverage ??
    snapshot.python?.applicationDefaults?.coverage ??
    snapshot.coveragePolicies?.[0]?.id;
  if (!coverage) {
    throw new Error(`Paused Python application ${target.spec} has no configured coverage`);
  }
  const coverageId =
    typeof coverage === 'string'
      ? coverage
      : `inline-${platformCoveragePolicyDigest(coverage).slice(0, 12)}`;
  return pythonApplicationTargetId(parsed.requirement.normalizedName, coverageId);
}

function applicationMatchesScope(
  application: PythonApplicationBundleEntry,
  scopeId: string
): boolean {
  const selectionId = application.selectionId ?? application.targetId;
  return (
    selectionId === scopeId ||
    application.targetId === scopeId ||
    application.targetId.startsWith(`${scopeId}--version-`)
  );
}

function filterPythonApplications(
  index: PythonApplicationBundleIndex | undefined,
  snapshot: WorkspaceSnapshot
): PythonApplicationBundleIndex | undefined {
  if (!index) return undefined;
  const pausedScopeIds = new Set(
    snapshot.targets
      .filter(
        (target): target is WorkspacePythonApplicationTarget =>
          target.type === 'python-app' && target.paused === true
      )
      .map((target) => pythonApplicationScopeId(snapshot, target))
  );
  if (pausedScopeIds.size === 0) return index;
  const activeScopeIds = new Set(
    snapshot.targets
      .filter(
        (target): target is WorkspacePythonApplicationTarget =>
          target.type === 'python-app' && target.paused !== true
      )
      .map((target) => pythonApplicationScopeId(snapshot, target))
  );
  for (const id of activeScopeIds) pausedScopeIds.delete(id);

  const excludedTargetIds = new Set(
    index.applications
      .filter((application) =>
        [...pausedScopeIds].some((scopeId) => applicationMatchesScope(application, scopeId))
      )
      .map((application) => application.targetId)
  );
  const applications = index.applications.filter(
    (application) => !excludedTargetIds.has(application.targetId)
  );
  const artifacts = index.artifacts
    .map((artifact) => ({
      ...artifact,
      references: artifact.references.filter(
        (reference) => !excludedTargetIds.has(reference.targetId)
      ),
    }))
    .filter((artifact) => artifact.references.length > 0);
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const normalizedApplications = applications.map((application) => ({
    ...application,
    artifactIds: application.artifactIds.filter((id) => artifactIds.has(id)),
  }));
  return {
    ...index,
    applications: normalizedApplications,
    artifacts,
    summary: {
      applications: normalizedApplications.length,
      artifacts: artifacts.length,
      totalBytes: artifacts.reduce((total, artifact) => total + artifact.size, 0),
    },
  };
}

function unpausedCpythonTarget(
  target: WorkspaceCpythonDistributionsTarget
): WorkspaceCpythonDistributionsTarget {
  const normalized = { ...target };
  delete normalized.paused;
  return normalized;
}

function filterCpythonDistributions(
  index: CpythonDistributionBundleIndex | undefined,
  snapshot: WorkspaceSnapshot
): CpythonDistributionBundleIndex | undefined {
  if (!index) return undefined;
  const pausedTargetIds = new Set(
    snapshot.targets
      .filter(
        (target): target is WorkspaceCpythonDistributionsTarget =>
          target.type === 'cpython-distributions' && target.paused === true
      )
      .map((target) => cpythonDistributionTargetId(unpausedCpythonTarget(target)))
  );
  if (pausedTargetIds.size === 0) return index;
  const activeTargetIds = new Set(
    snapshot.targets
      .filter(
        (target): target is WorkspaceCpythonDistributionsTarget =>
          target.type === 'cpython-distributions' && target.paused !== true
      )
      .map((target) => cpythonDistributionTargetId(unpausedCpythonTarget(target)))
  );
  for (const id of activeTargetIds) pausedTargetIds.delete(id);

  const targets = index.targets.filter((target) => !pausedTargetIds.has(target.targetId));
  const artifacts = index.artifacts
    .map((artifact) => ({
      ...artifact,
      references: artifact.references.filter((reference) => !pausedTargetIds.has(reference)),
    }))
    .filter((artifact) => artifact.references.length > 0);
  return {
    ...index,
    artifacts,
    summary: {
      artifacts: artifacts.length,
      bytes: artifacts.reduce((total, artifact) => total + artifact.size, 0),
      targets: targets.length,
    },
    targets,
  };
}

export function createPausedPublicationScope(options: {
  cpythonIndex?: CpythonDistributionBundleIndex;
  gitSources: GitSourcesManifest;
  manifest: BundleManifest;
  pythonApplicationIndex?: PythonApplicationBundleIndex;
  snapshot?: WorkspaceSnapshot;
}): PausedPublicationScope {
  const snapshot = options.snapshot;
  const pausedTargetIndexes =
    snapshot?.targets.flatMap((target, index) => (target.paused === true ? [index + 1] : [])) ?? [];
  if (!snapshot || pausedTargetIndexes.length === 0) {
    return {
      ...(options.cpythonIndex ? { cpythonIndex: options.cpythonIndex } : {}),
      gitSources: options.gitSources,
      ...(options.pythonApplicationIndex
        ? { pythonApplicationIndex: options.pythonApplicationIndex }
        : {}),
    };
  }

  const allTargetsPaused =
    snapshot.targets.length > 0 && snapshot.targets.every((target) => target.paused === true);

  const pausedGitIds = new Set(
    snapshot.targets
      .filter(
        (target): target is SnapshotGitTarget => target.type === 'git' && target.paused === true
      )
      .map((target) => target.sourceId)
  );
  if (allTargetsPaused) {
    for (const source of options.gitSources.sources) pausedGitIds.add(source.id);
  }
  for (const target of snapshot.targets) {
    if (target.type === 'git' && target.paused !== true) pausedGitIds.delete(target.sourceId);
  }
  const gitSources = {
    ...options.gitSources,
    sources: options.gitSources.sources.filter((source) => !pausedGitIds.has(source.id)),
  };
  const npmPackageIds = allTargetsPaused
    ? new Set<string>()
    : includedNpmPackageIds(options.manifest, snapshot);
  const pythonApplicationIndex = filterPythonApplications(options.pythonApplicationIndex, snapshot);
  const pythonFilePaths = pythonApplicationIndex
    ? new Set(pythonApplicationIndex.artifacts.map((artifact) => artifact.file))
    : undefined;
  const cpythonIndex = filterCpythonDistributions(options.cpythonIndex, snapshot);
  const cpythonArtifactIds = cpythonIndex
    ? new Set(cpythonIndex.artifacts.map((artifact) => artifact.id))
    : undefined;

  const report: PausedPublicationReport = {
    skipped: {
      cpythonArtifacts:
        (options.cpythonIndex?.artifacts.length ?? 0) - (cpythonIndex?.artifacts.length ?? 0),
      gitRepositories: options.gitSources.sources.length - gitSources.sources.length,
      npmPackages: npmPackageIds ? options.manifest.packages.length - npmPackageIds.size : 0,
      pythonApplications:
        (options.pythonApplicationIndex?.applications.length ?? 0) -
        (pythonApplicationIndex?.applications.length ?? 0),
      pythonArtifacts:
        (options.pythonApplicationIndex?.artifacts.length ?? 0) -
        (pythonApplicationIndex?.artifacts.length ?? 0),
    },
    targetIndexes: pausedTargetIndexes,
  };
  return {
    ...(cpythonArtifactIds ? { cpythonArtifactIds } : {}),
    ...(cpythonIndex ? { cpythonIndex } : {}),
    gitSources,
    ...(npmPackageIds ? { npmPackageIds } : {}),
    ...(pythonApplicationIndex ? { pythonApplicationIndex } : {}),
    ...(pythonFilePaths ? { pythonFilePaths } : {}),
    report,
  };
}
