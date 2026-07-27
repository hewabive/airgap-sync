import path from 'node:path';
import { createPythonEnvironmentPlan, type PythonEnvironmentPlan } from './environment-plan.js';
import type { PythonLockedPackage, PythonLockInput } from './input-types.js';
import type { PythonIndexClient, PythonIndexFile, PythonProjectIndex } from './index-client.js';
import {
  resolveTargetEnvironment,
  wheelPriorityInEnvironment,
  type ResolvedTargetEnvironment,
} from './environments.js';
import { compareVersions, isPrereleaseVersion, versionSatisfies } from './pep440.js';
import { getBuiltInPlatformFamily, type BuiltInPlatformFamilyId } from './platform-family.js';
import { platformCoveragePolicyDigest, type PlatformCoveragePolicy } from './coverage-policy.js';
import type { PythonApplicationIntent } from './application-intent.js';
import type { PythonApplicationRecipe } from './application-recipe.js';
import { normalizePackageName } from './names.js';
import { parseWheelFilename, type WheelFilename } from './wheels.js';
import type { PythonApplicationResolver, UvResolutionEvidence } from './uv-adapter.js';
import { UvResolutionError } from './uv-adapter.js';
import { uvToolManifest } from './uv-tool.js';

export interface PythonPlannerPolicy {
  glibcBaselines: string[];
  pythonMinors: string[];
  version: 1;
}

export const defaultPythonPlannerPolicy: PythonPlannerPolicy = {
  glibcBaselines: ['2.17', '2.28', '2.31', '2.34', '2.35', '2.36', '2.39'],
  pythonMinors: ['3.13', '3.12', '3.11', '3.10'],
  version: 1,
};

export interface PythonPlannerCandidate {
  applicationVersion: string;
  platforms: {
    glibc?: string;
    platformFamilyId: BuiltInPlatformFamilyId;
  }[];
  pythonMinor: string;
}

export interface PythonPlannerRejection {
  applicationVersion: string;
  platformFamilyId?: string;
  pythonMinor: string;
  reason: string;
}

export interface PythonPlannerEvidence {
  glibc?: string;
  platformFamilyId: BuiltInPlatformFamilyId;
  pylock: UvResolutionEvidence;
  pythonMinor: string;
}

export interface PlanPythonApplicationResult {
  evidence: PythonPlannerEvidence[];
  plan: PythonEnvironmentPlan;
  rejectedCandidates: PythonPlannerRejection[];
}

export interface PlanPythonApplicationOptions {
  cacheDir: string;
  coveragePolicy: PlatformCoveragePolicy;
  createdAt?: string;
  cutoff?: string;
  index: PythonIndexClient;
  intent: PythonApplicationIntent;
  plannerPolicy?: PythonPlannerPolicy;
  recipe?: PythonApplicationRecipe;
  resolver: PythonApplicationResolver;
  uvPath: string;
  workDir: string;
}

export class PythonApplicationPlanningError extends Error {
  readonly rejectedCandidates: PythonPlannerRejection[];

  constructor(message: string, rejectedCandidates: PythonPlannerRejection[]) {
    super(message);
    this.name = 'PythonApplicationPlanningError';
    this.rejectedCandidates = rejectedCandidates;
  }
}

function orderedPythonMinors(
  policy: PythonPlannerPolicy,
  intent: PythonApplicationIntent,
  recipe: PythonApplicationRecipe | undefined
): string[] {
  const preferred = recipe?.compatibility?.preferredPythonMinors ?? [];
  const ordered = [...preferred, ...policy.pythonMinors].filter(
    (minor, index, all) => all.indexOf(minor) === index
  );
  return ordered.filter((minor) => {
    const version = `${minor}.0`;
    return (
      (intent.python.policy === 'auto' || versionSatisfies(version, intent.python.version)) &&
      (!recipe?.compatibility?.requiresPython ||
        versionSatisfies(version, recipe.compatibility.requiresPython))
    );
  });
}

function indexFileAllowed(file: PythonIndexFile, cutoff: string | undefined): boolean {
  if (file.yanked !== undefined) {
    return false;
  }
  if (!cutoff || !file.uploadTime) {
    return true;
  }
  return Date.parse(file.uploadTime) <= Date.parse(cutoff);
}

function applicationVersions(
  project: PythonProjectIndex,
  intent: PythonApplicationIntent,
  recipe: PythonApplicationRecipe | undefined,
  cutoff: string | undefined
): string[] {
  const versions = new Set<string>();
  for (const file of project.files) {
    if (!indexFileAllowed(file, cutoff)) {
      continue;
    }
    const wheel = parseWheelFilename(file.filename);
    if (
      wheel?.normalizedName === normalizePackageName(intent.application.name) &&
      !isPrereleaseVersion(wheel.version)
    ) {
      versions.add(wheel.version);
    }
  }
  return [...versions]
    .filter(
      (version) =>
        (!intent.application.version || versionSatisfies(version, intent.application.version)) &&
        (!recipe?.compatibility?.applicationVersions ||
          versionSatisfies(version, recipe.compatibility.applicationVersions))
    )
    .sort((left, right) => compareVersions(right, left));
}

export function generatePythonPlannerCandidates(options: {
  applicationVersions: string[];
  coveragePolicy: PlatformCoveragePolicy;
  intent: PythonApplicationIntent;
  plannerPolicy?: PythonPlannerPolicy;
  recipe?: PythonApplicationRecipe;
}): PythonPlannerCandidate[] {
  const policy = options.plannerPolicy ?? defaultPythonPlannerPolicy;
  return options.applicationVersions.flatMap((applicationVersion) =>
    orderedPythonMinors(policy, options.intent, options.recipe).map((pythonMinor) => {
      const platforms: PythonPlannerCandidate['platforms'] = [];
      for (const platformFamilyId of options.coveragePolicy.platforms) {
        if (platformFamilyId === 'linux-glibc-x86_64') {
          const explicit = options.coveragePolicy.linux?.oldestSupportedGlibc;
          platforms.push(
            ...(explicit
              ? [{ glibc: explicit, platformFamilyId }]
              : policy.glibcBaselines.map((glibc) => ({
                  glibc,
                  platformFamilyId,
                })))
          );
        } else {
          platforms.push({ platformFamilyId });
        }
      }
      return {
        applicationVersion,
        platforms,
        pythonMinor,
      };
    })
  );
}

function exactRequirement(intent: PythonApplicationIntent, version: string): string {
  const extras =
    intent.application.extras.length > 0
      ? `[${[...intent.application.extras].sort().join(',')}]`
      : '';
  return `${intent.application.name}${extras}==${version}`;
}

function targetEnvironment(
  platformFamilyId: BuiltInPlatformFamilyId,
  pythonMinor: string,
  glibc?: string
): ResolvedTargetEnvironment {
  if (platformFamilyId === 'windows-x86_64') {
    return resolveTargetEnvironment({
      arch: 'x86_64',
      name: `${platformFamilyId}--py${pythonMinor.replace('.', '')}`,
      os: 'windows',
      pythonVersion: `${pythonMinor}.0`,
    });
  }
  return resolveTargetEnvironment({
    arch: 'x86_64',
    manylinux: `manylinux_${(glibc ?? '2.17').replace('.', '_')}`,
    name: `${platformFamilyId}--py${pythonMinor.replace('.', '')}`,
    os: 'linux',
    pythonVersion: `${pythonMinor}.0`,
  });
}

function manylinuxFloor(platformTag: string): string | undefined {
  const match = /^manylinux_(\d+)_(\d+)_x86_64$/u.exec(platformTag);
  if (match) {
    return `${match[1]!}.${match[2]!}`;
  }
  if (platformTag === 'manylinux2014_x86_64') {
    return '2.17';
  }
  if (platformTag === 'manylinux2010_x86_64') {
    return '2.12';
  }
  if (platformTag === 'manylinux1_x86_64') {
    return '2.5';
  }
  return undefined;
}

function wheelMatchesFamily(
  wheel: WheelFilename,
  platformFamilyId: BuiltInPlatformFamilyId
): boolean {
  if (wheel.platformTags.includes('any')) {
    return true;
  }
  if (platformFamilyId === 'windows-x86_64') {
    return wheel.platformTags.some((tag) => tag === 'win_amd64');
  }
  return wheel.platformTags.some((tag) => manylinuxFloor(tag) !== undefined);
}

function highestCompatibilityFloor(current: string | undefined, candidate: string): string {
  return !current || compareVersions(candidate, current) > 0 ? candidate : current;
}

function lowestWheelFloor(wheels: WheelFilename[]): string {
  const floors = wheels.flatMap((wheel) =>
    wheel.platformTags.includes('any')
      ? ['0.0']
      : wheel.platformTags.flatMap((tag) => {
          const floor = manylinuxFloor(tag);
          return floor ? [floor] : [];
        })
  );
  return floors.sort(compareVersions)[0] ?? '0.0';
}

interface EnumeratedBranch {
  packages: {
    dependencies: string[];
    name: string;
    version: string;
    wheels: string[];
  }[];
  supportBoundary?: {
    glibc?: string;
  };
  wheels: {
    filename: string;
    package: string;
    sha256: string;
    size?: number;
    url: string;
    version: string;
  }[];
}

type VersionedLockedPackage = PythonLockedPackage & { version: string };

function lockedRegistryPackages(lock: PythonLockInput): VersionedLockedPackage[] {
  const packages = lock.packages.filter(
    (pkg): pkg is VersionedLockedPackage =>
      pkg.sourceKind === 'registry' && typeof pkg.version === 'string'
  );
  if (packages.length !== lock.packages.length) {
    throw new Error('Application plans support registry packages only');
  }
  return packages;
}

async function enumerateBranchArtifacts(options: {
  cutoff?: string;
  evidence: UvResolutionEvidence;
  glibc?: string;
  index: PythonIndexClient;
  platformFamilyId: BuiltInPlatformFamilyId;
  pythonMinor: string;
}): Promise<EnumeratedBranch> {
  const baselineEnvironment = targetEnvironment(
    options.platformFamilyId,
    options.pythonMinor,
    options.glibc
  );
  const broadEnvironment = targetEnvironment(
    options.platformFamilyId,
    options.pythonMinor,
    options.platformFamilyId === 'linux-glibc-x86_64' ? '2.99' : undefined
  );
  const packages: EnumeratedBranch['packages'] = [];
  const selectedWheels: EnumeratedBranch['wheels'] = [];
  let inferredGlibc: string | undefined;

  for (const locked of lockedRegistryPackages(options.evidence.lock).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const project = await options.index.getProject(locked.name);
    const candidates = project.files.flatMap((file) => {
      if (!indexFileAllowed(file, options.cutoff)) {
        return [];
      }
      const wheel = parseWheelFilename(file.filename);
      const sha256 = file.hashes.sha256;
      if (
        !wheel ||
        !sha256 ||
        !/^[a-f0-9]{64}$/u.test(sha256) ||
        wheel.normalizedName !== locked.name ||
        compareVersions(wheel.version, locked.version) !== 0 ||
        !wheelMatchesFamily(wheel, options.platformFamilyId) ||
        wheelPriorityInEnvironment(wheel, broadEnvironment) === undefined ||
        (file.requiresPython && !versionSatisfies(`${options.pythonMinor}.0`, file.requiresPython))
      ) {
        return [];
      }
      return [{ file, sha256, wheel }];
    });
    const installable = candidates.filter(
      ({ wheel }) => wheelPriorityInEnvironment(wheel, baselineEnvironment) !== undefined
    );
    if (installable.length === 0) {
      throw new Error(
        `${locked.name}==${locked.version} has no wheel for ${options.platformFamilyId} on Python ${options.pythonMinor}${options.glibc ? ` at glibc ${options.glibc}` : ''}`
      );
    }
    if (options.platformFamilyId === 'linux-glibc-x86_64') {
      inferredGlibc = highestCompatibilityFloor(
        inferredGlibc,
        lowestWheelFloor(installable.map(({ wheel }) => wheel))
      );
    }
    const branchWheels = candidates
      .sort((left, right) => left.file.filename.localeCompare(right.file.filename))
      .map(({ file, sha256 }) => ({
        filename: file.filename,
        package: locked.name,
        sha256,
        ...(file.size !== undefined ? { size: file.size } : {}),
        url: file.url,
        version: locked.version,
      }));
    selectedWheels.push(...branchWheels);
    packages.push({
      dependencies: locked.dependencies.map((dependency) => dependency.name).sort(),
      name: locked.name,
      version: locked.version,
      wheels: branchWheels.map((wheel) => wheel.filename),
    });
  }

  return {
    packages,
    ...(inferredGlibc && inferredGlibc !== '0.0'
      ? { supportBoundary: { glibc: inferredGlibc } }
      : {}),
    wheels: selectedWheels,
  };
}

function mergePlanWheels(
  branches: {
    artifacts: EnumeratedBranch;
    platformFamilyId: BuiltInPlatformFamilyId;
  }[]
): PythonEnvironmentPlan['wheels'] {
  const wheels = new Map<string, PythonEnvironmentPlan['wheels'][number]>();
  for (const branch of branches) {
    for (const wheel of branch.artifacts.wheels) {
      const key = `${wheel.filename}\0${wheel.sha256}`;
      const existing = wheels.get(key);
      if (existing) {
        if (!existing.platforms.includes(branch.platformFamilyId)) {
          existing.platforms.push(branch.platformFamilyId);
          existing.platforms.sort();
        }
      } else {
        wheels.set(key, {
          ...wheel,
          platforms: [branch.platformFamilyId],
        });
      }
    }
  }
  return [...wheels.values()].sort((left, right) => left.filename.localeCompare(right.filename));
}

async function resolveCandidate(
  options: PlanPythonApplicationOptions,
  applicationVersion: string,
  pythonMinor: string,
  rejectedCandidates: PythonPlannerRejection[]
): Promise<
  | {
      branches: {
        artifacts: EnumeratedBranch;
        evidence: UvResolutionEvidence;
        glibc?: string;
        platformFamilyId: BuiltInPlatformFamilyId;
      }[];
    }
  | undefined
> {
  const policy = options.plannerPolicy ?? defaultPythonPlannerPolicy;
  const branches: {
    artifacts: EnumeratedBranch;
    evidence: UvResolutionEvidence;
    glibc?: string;
    platformFamilyId: BuiltInPlatformFamilyId;
  }[] = [];
  for (const platformFamilyId of options.coveragePolicy.platforms) {
    const baselines =
      platformFamilyId === 'linux-glibc-x86_64'
        ? options.coveragePolicy.linux?.oldestSupportedGlibc
          ? [options.coveragePolicy.linux.oldestSupportedGlibc]
          : policy.glibcBaselines
        : [undefined];
    let resolvedBranch:
      | {
          artifacts: EnumeratedBranch;
          evidence: UvResolutionEvidence;
          glibc?: string;
          platformFamilyId: BuiltInPlatformFamilyId;
        }
      | undefined;
    const baselineFailures: string[] = [];
    for (const glibc of baselines) {
      try {
        const branchName = `${applicationVersion}--py${pythonMinor.replace('.', '')}--${platformFamilyId}${glibc ? `--glibc-${glibc}` : ''}`;
        const evidence = await options.resolver.resolve({
          cacheDir: options.cacheDir,
          ...(options.cutoff ? { cutoff: options.cutoff } : {}),
          ...(glibc ? { glibc } : {}),
          platformFamilyId,
          pythonMinor,
          requirement: exactRequirement(options.intent, applicationVersion),
          sourceIndex: options.index.sourceIndex,
          uvPath: options.uvPath,
          workDir: path.join(options.workDir, branchName),
        });
        const artifacts = await enumerateBranchArtifacts({
          ...(options.cutoff ? { cutoff: options.cutoff } : {}),
          evidence,
          ...(glibc ? { glibc } : {}),
          index: options.index,
          platformFamilyId,
          pythonMinor,
        });
        resolvedBranch = {
          artifacts,
          evidence,
          ...(glibc ? { glibc } : {}),
          platformFamilyId,
        };
        break;
      } catch (error) {
        const detail =
          error instanceof UvResolutionError
            ? `${error.kind}: ${error.message}`
            : (error as Error).message;
        baselineFailures.push(`${glibc ? `glibc ${glibc}: ` : ''}${detail}`);
      }
    }
    if (!resolvedBranch) {
      rejectedCandidates.push({
        applicationVersion,
        platformFamilyId,
        pythonMinor,
        reason: baselineFailures.join(' | '),
      });
      return undefined;
    }
    branches.push(resolvedBranch);
  }
  return { branches };
}

export async function planPythonApplication(
  options: PlanPythonApplicationOptions
): Promise<PlanPythonApplicationResult> {
  const rootProject = await options.index.getProject(options.intent.application.name);
  const versions = applicationVersions(rootProject, options.intent, options.recipe, options.cutoff);
  if (versions.length === 0) {
    throw new PythonApplicationPlanningError(
      `No stable application version satisfies ${options.intent.application.version ?? 'the requested policy'}`,
      []
    );
  }
  const candidates = generatePythonPlannerCandidates({
    applicationVersions: versions,
    coveragePolicy: options.coveragePolicy,
    intent: options.intent,
    ...(options.plannerPolicy ? { plannerPolicy: options.plannerPolicy } : {}),
    ...(options.recipe ? { recipe: options.recipe } : {}),
  });
  const uniqueCandidates = candidates.filter(
    (candidate, index, all) =>
      all.findIndex(
        (item) =>
          item.applicationVersion === candidate.applicationVersion &&
          item.pythonMinor === candidate.pythonMinor
      ) === index
  );
  const rejectedCandidates: PythonPlannerRejection[] = [];
  for (const candidate of uniqueCandidates) {
    const resolved = await resolveCandidate(
      options,
      candidate.applicationVersion,
      candidate.pythonMinor,
      rejectedCandidates
    );
    if (!resolved) {
      continue;
    }
    const families = options.coveragePolicy.platforms.map((id) => {
      const family = getBuiltInPlatformFamily(id);
      if (!family) {
        throw new Error(`Unknown platform family: ${id}`);
      }
      return family;
    });
    const plan = createPythonEnvironmentPlan({
      application: {
        name: normalizePackageName(options.intent.application.name),
        version: candidate.applicationVersion,
      },
      coverage: {
        digest: platformCoveragePolicyDigest(options.coveragePolicy),
        families,
        policy: options.coveragePolicy,
      },
      createdAt: options.createdAt ?? new Date().toISOString(),
      intent: options.intent,
      platforms: resolved.branches.map((branch) => ({
        packages: branch.artifacts.packages,
        platformFamilyId: branch.platformFamilyId,
        pythonMinor: candidate.pythonMinor,
        rejectedReasons: [],
        requiresPython: `>=${candidate.pythonMinor},<3.${String(Number(candidate.pythonMinor.split('.')[1]) + 1)}`,
        status: 'supported',
        ...(branch.artifacts.supportBoundary
          ? { supportBoundary: branch.artifacts.supportBoundary }
          : {}),
      })),
      preferredPythonMinor: candidate.pythonMinor,
      ...(rejectedCandidates.length > 0
        ? {
            presentation: {
              rejectedCandidateSummaries: rejectedCandidates.map(
                (rejection) =>
                  `${rejection.applicationVersion} / Python ${rejection.pythonMinor}${rejection.platformFamilyId ? ` / ${rejection.platformFamilyId}` : ''}: ${rejection.reason}`
              ),
            },
          }
        : {}),
      resolver: {
        ...(options.cutoff ? { cutoff: options.cutoff } : {}),
        engine: 'uv',
        policyVersion: (options.plannerPolicy ?? defaultPythonPlannerPolicy).version,
        version: uvToolManifest.version,
      },
      schemaVersion: 1,
      wheels: mergePlanWheels(resolved.branches),
    });
    return {
      evidence: resolved.branches.map((branch) => ({
        ...(branch.glibc ? { glibc: branch.glibc } : {}),
        platformFamilyId: branch.platformFamilyId,
        pylock: branch.evidence,
        pythonMinor: candidate.pythonMinor,
      })),
      plan,
      rejectedCandidates,
    };
  }
  throw new PythonApplicationPlanningError(
    `No application version and Python minor covers ${options.coveragePolicy.platforms.join(', ')}`,
    rejectedCandidates
  );
}
