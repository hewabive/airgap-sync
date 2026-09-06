import path from 'node:path';
import { semanticDigest } from '../canonical-json.js';
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
import {
  assertPythonApplicationRecipeCurrent,
  pythonRecipeIncompatibilityReason,
  resolvePythonApplicationRecipe,
  pythonApplicationRecipeForVersion,
  type PythonApplicationRecipe,
} from './application-recipe.js';
import { normalizePackageName } from './names.js';
import { parseWheelFilename, type WheelFilename } from './wheels.js';
import type { PythonApplicationResolver, UvResolutionEvidence } from './uv-adapter.js';
import { UvResolutionError } from './uv-adapter.js';
import { uvToolManifest } from './uv-tool.js';
import {
  pythonPlatformPylockPath,
  pythonPlatformRequirementsLockPath,
} from './application-paths.js';

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
  onProgress?: (candidate: {
    applicationVersion: string;
    pythonMinor: string;
    platformFamilyId: BuiltInPlatformFamilyId;
    glibc?: string;
  }) => void;
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
  if (intent.python.policy === 'selected') {
    const selected = [...new Set(intent.python.versions)];
    return [...preferred.filter((minor) => selected.includes(minor)), ...selected].filter(
      (minor, index, all) => all.indexOf(minor) === index
    );
  }
  const versionConstraint =
    intent.python.policy === 'constrained' ? intent.python.version : undefined;
  const ordered = [...preferred, ...policy.pythonMinors].filter(
    (minor, index, all) => all.indexOf(minor) === index
  );
  return ordered.filter((minor) => {
    const version = `${minor}.0`;
    return !versionConstraint || versionSatisfies(version, versionConstraint);
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
        !intent.application.version || versionSatisfies(version, intent.application.version)
    )
    .sort((left, right) => compareVersions(right, left));
}

function applicationPythonIncompatibilityReason(
  project: PythonProjectIndex,
  applicationName: string,
  applicationVersion: string,
  pythonMinor: string,
  cutoff: string | undefined
): string | undefined {
  const files = project.files.filter((file) => {
    if (!indexFileAllowed(file, cutoff)) {
      return false;
    }
    const wheel = parseWheelFilename(file.filename);
    return (
      wheel?.normalizedName === normalizePackageName(applicationName) &&
      compareVersions(wheel.version, applicationVersion) === 0
    );
  });
  if (
    files.some(
      (file) => !file.requiresPython || versionSatisfies(`${pythonMinor}.0`, file.requiresPython)
    )
  ) {
    return undefined;
  }
  const constraints = [...new Set(files.flatMap((file) => file.requiresPython ?? []))].sort();
  return constraints.length > 0
    ? `application files require Python ${constraints.join(' or ')}`
    : undefined;
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
    orderedPythonMinors(
      policy,
      options.intent,
      pythonApplicationRecipeForVersion(options.recipe, applicationVersion)
    ).map((pythonMinor) => {
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

function exactRequirements(
  intent: PythonApplicationIntent,
  version: string,
  recipe: PythonApplicationRecipe | undefined
): { additionalRequirements: string[]; requirement: string } {
  const resolvedRecipe = resolvePythonApplicationRecipe(recipe, intent);
  const extras = resolvedRecipe.extras.length > 0 ? `[${resolvedRecipe.extras.join(',')}]` : '';
  return {
    additionalRequirements: resolvedRecipe.additionalRequirements,
    requirement: `${intent.application.name}${extras}==${version}`,
  };
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

class PythonBranchCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PythonBranchCompatibilityError';
  }
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
      throw new PythonBranchCompatibilityError(
        `${locked.name}==${locked.version} has no wheel for ${options.platformFamilyId} on Python ${options.pythonMinor}${options.glibc ? ` at glibc ${options.glibc}` : ''}`
      );
    }
    if (options.platformFamilyId === 'linux-glibc-x86_64') {
      inferredGlibc = highestCompatibilityFloor(
        inferredGlibc,
        lowestWheelFloor(installable.map(({ wheel }) => wheel))
      );
    }
    const branchWheels = installable
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

interface ResolvedBranchArtifacts {
  artifacts: EnumeratedBranch;
  glibc?: string;
  platformFamilyId: BuiltInPlatformFamilyId;
  pythonMinor: string;
}

interface WheelCoverCandidate {
  branchMask: bigint;
  key: string;
  size?: number;
}

interface WheelCoverSelection {
  keys: string[];
  knownBytes: number;
  unknownSizes: number;
}

function planWheelKey(wheel: EnumeratedBranch['wheels'][number]): string {
  return `${wheel.package}\0${wheel.version}\0${wheel.filename}\0${wheel.sha256}`;
}

function betterWheelCover(
  candidate: WheelCoverSelection,
  current: WheelCoverSelection | undefined
): boolean {
  if (!current) {
    return true;
  }
  if (candidate.unknownSizes !== current.unknownSizes) {
    return candidate.unknownSizes < current.unknownSizes;
  }
  if (candidate.knownBytes !== current.knownBytes) {
    return candidate.knownBytes < current.knownBytes;
  }
  if (candidate.keys.length !== current.keys.length) {
    return candidate.keys.length < current.keys.length;
  }
  return candidate.keys.join('\0').localeCompare(current.keys.join('\0')) < 0;
}

function selectMinimumWheelCover(branches: ResolvedBranchArtifacts[]): void {
  const packageBranches = new Map<string, number[]>();
  for (const [branchIndex, branch] of branches.entries()) {
    for (const pkg of branch.artifacts.packages) {
      const packageKey = `${pkg.name}\0${pkg.version}`;
      const indexes = packageBranches.get(packageKey) ?? [];
      indexes.push(branchIndex);
      packageBranches.set(packageKey, indexes);
    }
  }

  const selectedWheelKeys = new Set<string>();
  for (const [packageKey, branchIndexes] of packageBranches) {
    const candidates = new Map<string, WheelCoverCandidate>();
    for (const branchIndex of branchIndexes) {
      const branch = branches[branchIndex]!;
      const [packageName, packageVersion] = packageKey.split('\0');
      for (const wheel of branch.artifacts.wheels.filter(
        (item) => item.package === packageName && item.version === packageVersion
      )) {
        const key = planWheelKey(wheel);
        const existing = candidates.get(key);
        candidates.set(key, {
          branchMask: (existing?.branchMask ?? 0n) | (1n << BigInt(branchIndex)),
          key,
          ...(wheel.size !== undefined ? { size: wheel.size } : {}),
        });
      }
    }
    const requiredMask = branchIndexes.reduce(
      (mask, branchIndex) => mask | (1n << BigInt(branchIndex)),
      0n
    );
    const states = new Map<bigint, WheelCoverSelection>([
      [0n, { keys: [], knownBytes: 0, unknownSizes: 0 }],
    ]);
    for (const candidate of [...candidates.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
    )) {
      for (const [mask, selection] of [...states.entries()]) {
        const nextMask = mask | candidate.branchMask;
        if (nextMask === mask) {
          continue;
        }
        const next: WheelCoverSelection = {
          keys: [...selection.keys, candidate.key],
          knownBytes: selection.knownBytes + (candidate.size ?? 0),
          unknownSizes: selection.unknownSizes + (candidate.size === undefined ? 1 : 0),
        };
        if (betterWheelCover(next, states.get(nextMask))) {
          states.set(nextMask, next);
        }
      }
    }
    const selected = states.get(requiredMask);
    if (!selected) {
      throw new Error(`No wheel set covers every compatibility cell for ${packageKey}`);
    }
    for (const key of selected.keys) {
      selectedWheelKeys.add(key);
    }
  }

  for (const branch of branches) {
    branch.artifacts.wheels = branch.artifacts.wheels.filter((wheel) =>
      selectedWheelKeys.has(planWheelKey(wheel))
    );
    for (const pkg of branch.artifacts.packages) {
      const selectedFilenames = new Set(
        branch.artifacts.wheels
          .filter((wheel) => wheel.package === pkg.name && wheel.version === pkg.version)
          .map((wheel) => wheel.filename)
      );
      pkg.wheels = pkg.wheels.filter((filename) => selectedFilenames.has(filename));
      if (pkg.wheels.length === 0) {
        throw new Error(
          `Minimum wheel cover left ${pkg.name}==${pkg.version} uncovered for ${branch.platformFamilyId} on Python ${branch.pythonMinor}`
        );
      }
    }
  }
}

async function resolveCandidate(
  options: PlanPythonApplicationOptions,
  rootProject: PythonProjectIndex,
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
  const applicationIncompatibility = applicationPythonIncompatibilityReason(
    rootProject,
    options.intent.application.name,
    applicationVersion,
    pythonMinor,
    options.cutoff
  );
  if (applicationIncompatibility) {
    rejectedCandidates.push({
      applicationVersion,
      pythonMinor,
      reason: `application-incompatible: ${applicationIncompatibility}`,
    });
    return undefined;
  }
  const policy = options.plannerPolicy ?? defaultPythonPlannerPolicy;
  const branches: {
    artifacts: EnumeratedBranch;
    evidence: UvResolutionEvidence;
    glibc?: string;
    platformFamilyId: BuiltInPlatformFamilyId;
  }[] = [];
  for (const platformFamilyId of options.coveragePolicy.platforms) {
    const recipeIncompatibility = pythonRecipeIncompatibilityReason(
      options.recipe,
      options.intent,
      {
        applicationVersion,
        platformFamilyId,
        pythonMinor,
      }
    );
    if (recipeIncompatibility) {
      rejectedCandidates.push({
        applicationVersion,
        platformFamilyId,
        pythonMinor,
        reason: `recipe-incompatible: ${recipeIncompatibility}`,
      });
      return undefined;
    }
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
        const requirements = exactRequirements(options.intent, applicationVersion, options.recipe);
        options.onProgress?.({
          applicationVersion,
          pythonMinor,
          platformFamilyId,
          ...(glibc ? { glibc } : {}),
        });
        const evidence = await options.resolver.resolve({
          ...(requirements.additionalRequirements.length > 0
            ? { additionalRequirements: requirements.additionalRequirements }
            : {}),
          cacheDir: options.cacheDir,
          ...(options.cutoff ? { cutoff: options.cutoff } : {}),
          ...(glibc ? { glibc } : {}),
          platformFamilyId,
          pythonMinor,
          requirement: requirements.requirement,
          sourceIndex: options.index.sourceIndex,
          ...(options.intent.source.resolution?.prerelease
            ? { prerelease: options.intent.source.resolution.prerelease }
            : {}),
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
        if (
          error instanceof UvResolutionError &&
          error.kind !== 'no-solution' &&
          error.kind !== 'no-wheel'
        ) {
          throw error;
        }
        if (
          !(error instanceof UvResolutionError) &&
          !(error instanceof PythonBranchCompatibilityError)
        ) {
          throw error;
        }
        const detail =
          error instanceof UvResolutionError
            ? `${error.kind}: ${error.message}${error.stderr.trim() ? `\n${error.stderr.trim()}` : ''}`
            : error.message;
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
  const createdAt = options.createdAt ?? new Date().toISOString();
  resolvePythonApplicationRecipe(options.recipe, options.intent);
  const rootProject = await options.index.getProject(options.intent.application.name);
  const versions = applicationVersions(rootProject, options.intent, options.cutoff);
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
  const applicationVersionCandidates = [
    ...new Set(uniqueCandidates.map((candidate) => candidate.applicationVersion)),
  ];
  for (const applicationVersion of applicationVersionCandidates) {
    const recipe = pythonApplicationRecipeForVersion(options.recipe, applicationVersion);
    assertPythonApplicationRecipeCurrent(recipe, createdAt);
    const candidateOptions = { ...options };
    if (!recipe) {
      delete candidateOptions.recipe;
    }

    const pythonMinors = uniqueCandidates
      .filter((candidate) => candidate.applicationVersion === applicationVersion)
      .map((candidate) => candidate.pythonMinor);
    const resolvedBranches: {
      artifacts: EnumeratedBranch;
      evidence: UvResolutionEvidence;
      glibc?: string;
      platformFamilyId: BuiltInPlatformFamilyId;
      pythonMinor: string;
    }[] = [];
    for (const pythonMinor of pythonMinors) {
      if (
        options.recipe &&
        !recipe &&
        Object.keys(options.intent.application.features).length > 0
      ) {
        rejectedCandidates.push({
          applicationVersion,
          pythonMinor,
          reason: `recipe-incompatible: selected features require a recipe covering ${applicationVersion}`,
        });
        continue;
      }
      const resolved = await resolveCandidate(
        candidateOptions,
        rootProject,
        applicationVersion,
        pythonMinor,
        rejectedCandidates
      );
      if (resolved) {
        resolvedBranches.push(...resolved.branches.map((branch) => ({ ...branch, pythonMinor })));
      }
    }
    if (resolvedBranches.length === 0) {
      continue;
    }
    selectMinimumWheelCover(resolvedBranches);
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
        version: applicationVersion,
      },
      coverage: {
        digest: platformCoveragePolicyDigest(options.coveragePolicy),
        families,
        policy: options.coveragePolicy,
      },
      createdAt,
      intent: options.intent,
      platforms: resolvedBranches.map((branch) => ({
        packages: branch.artifacts.packages,
        platformFamilyId: branch.platformFamilyId,
        pylockPath: pythonPlatformPylockPath(branch.platformFamilyId, branch.pythonMinor),
        pythonMinor: branch.pythonMinor,
        rejectedReasons: [],
        requirementsLockPath: pythonPlatformRequirementsLockPath(
          branch.platformFamilyId,
          branch.pythonMinor
        ),
        requiresPython: `>=${branch.pythonMinor},<3.${String(Number(branch.pythonMinor.split('.')[1]) + 1)}`,
        status: 'supported',
        ...(branch.artifacts.supportBoundary
          ? { supportBoundary: branch.artifacts.supportBoundary }
          : {}),
      })),
      preferredPythonMinor: resolvedBranches[0]!.pythonMinor,
      presentation: {
        rejectedCandidateSummaries: rejectedCandidates.map(
          (rejection) =>
            `${rejection.applicationVersion} / Python ${rejection.pythonMinor}${rejection.platformFamilyId ? ` / ${rejection.platformFamilyId}` : ''}: ${rejection.reason}`
        ),
        requestedPythonMinors: pythonMinors,
        skippedPythonMinors: pythonMinors
          .filter(
            (pythonMinor) => !resolvedBranches.some((branch) => branch.pythonMinor === pythonMinor)
          )
          .map((pythonMinor) => ({
            pythonMinor,
            reasons: rejectedCandidates
              .filter(
                (rejection) =>
                  rejection.applicationVersion === applicationVersion &&
                  rejection.pythonMinor === pythonMinor
              )
              .map((rejection) => rejection.reason),
          })),
      },
      ...(options.recipe
        ? {
            recipe: {
              digest: semanticDigest(options.recipe),
              id: options.recipe.id,
              version: options.recipe.version,
            },
          }
        : {}),
      resolver: {
        ...(options.cutoff ? { cutoff: options.cutoff } : {}),
        engine: 'uv',
        policyVersion: (options.plannerPolicy ?? defaultPythonPlannerPolicy).version,
        version: uvToolManifest.version,
      },
      schemaVersion: 2,
      wheels: mergePlanWheels(resolvedBranches),
    });
    return {
      evidence: resolvedBranches.map((branch) => ({
        ...(branch.glibc ? { glibc: branch.glibc } : {}),
        platformFamilyId: branch.platformFamilyId,
        pylock: branch.evidence,
        pythonMinor: branch.pythonMinor,
      })),
      plan,
      rejectedCandidates,
    };
  }
  throw new PythonApplicationPlanningError(
    `No application version has a complete dependency tree for any requested Python minor on ${options.coveragePolicy.platforms.join(', ')}`,
    rejectedCandidates
  );
}
