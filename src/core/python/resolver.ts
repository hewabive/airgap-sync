import type {
  PythonRequirementInput,
  PythonLockInput,
  PythonLockedPackage,
} from './input-types.js';
import type { ParsedRequirement } from './requirements.js';
import { parseRequirement } from './requirements.js';
import type { PythonIndexClient, PythonIndexFile, PythonProjectIndex } from './index-client.js';
import { PythonMetadataCache } from './metadata.js';
import type { ResolvedTargetEnvironment } from './environments.js';
import {
  environmentSatisfiesRequiresPython,
  resolveTargetEnvironment,
  wheelPriorityInEnvironment,
  type PythonTargetEnvironmentConfig,
} from './environments.js';
import { evaluateMarker } from './markers.js';
import { maxSatisfyingVersion } from './pep440.js';
import { normalizePackageName } from './names.js';
import { parseWheelFilename } from './wheels.js';
import type {
  PythonResolutionError,
  PythonResolutionReason,
  PythonResolutionResult,
  ResolvedPythonArtifact,
} from './resolution-types.js';

interface RequirementEdge {
  constraint: boolean;
  hashes: PythonRequirementInput['hashes'];
  reason: PythonResolutionReason;
  requirement: ParsedRequirement;
}

interface SelectedPackage {
  edges: RequirementEdge[];
  extras: string[];
  file: PythonIndexFile;
  metadata: Awaited<ReturnType<PythonIndexClient['getMetadata']>>['metadata'];
  name: string;
  version: string;
}

export interface ResolvePythonOptions {
  cache: PythonMetadataCache;
  environments: PythonTargetEnvironmentConfig[];
  includeDev?: boolean;
  index: PythonIndexClient;
  lockfiles?: PythonLockInput[];
  requirements?: PythonRequirementInput[];
}

function markerApplies(
  marker: string | undefined,
  environment: ResolvedTargetEnvironment,
  extras: string[] = [],
  dependencyGroups: string[] = []
): boolean {
  return marker
    ? evaluateMarker(marker, {
        ...environment.markerEnvironment,
        dependency_groups: dependencyGroups,
        extra: extras,
        extras,
      })
    : true;
}

function exactPin(edges: RequirementEdge[]): boolean {
  return edges.some((edge) => /^={2,3}(?!.*\*)\s*[^,]+$/.test(edge.requirement.specifier));
}

function combinedSpecifier(edges: RequirementEdge[]): string {
  return edges
    .map((edge) => edge.requirement.specifier.trim())
    .filter(Boolean)
    .join(',');
}

function wheelMatchesRequirementHashes(file: PythonIndexFile, edges: RequirementEdge[]): boolean {
  const requiredHashes = edges.flatMap((edge) => edge.hashes);
  if (requiredHashes.length === 0) {
    return true;
  }
  return requiredHashes.some(
    (hash) => file.hashes[hash.algorithm.toLowerCase()]?.toLowerCase() === hash.digest.toLowerCase()
  );
}

function buildTagParts(buildTag: string | undefined): [number, string] {
  if (!buildTag) {
    return [-1, ''];
  }
  const match = /^(\d+)(.*)$/.exec(buildTag)!;
  return [Number(match[1]), match[2]!];
}

function compareBuildTags(left: string | undefined, right: string | undefined): number {
  const [leftNumber, leftSuffix] = buildTagParts(left);
  const [rightNumber, rightSuffix] = buildTagParts(right);
  return rightNumber - leftNumber || rightSuffix.localeCompare(leftSuffix);
}

function selectWheel(
  files: PythonIndexFile[],
  environment: ResolvedTargetEnvironment,
  allowYanked: boolean
): PythonIndexFile | undefined {
  return files
    .flatMap((file) => {
      const wheel = parseWheelFilename(file.filename);
      if (!wheel || (!allowYanked && file.yanked !== undefined)) {
        return [];
      }
      if (
        file.requiresPython &&
        !environmentSatisfiesRequiresPython(environment, file.requiresPython)
      ) {
        return [];
      }
      const priority = wheelPriorityInEnvironment(wheel, environment);
      return priority === undefined ? [] : [{ file, priority, wheel }];
    })
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        compareBuildTags(left.wheel.buildTag, right.wheel.buildTag) ||
        left.file.filename.localeCompare(right.file.filename)
    )[0]?.file;
}

function filesByVersion(project: PythonProjectIndex, name: string): Map<string, PythonIndexFile[]> {
  const result = new Map<string, PythonIndexFile[]>();
  for (const file of project.files) {
    const wheel = parseWheelFilename(file.filename);
    if (wheel?.normalizedName !== name) {
      continue;
    }
    const files = result.get(wheel.version) ?? [];
    files.push(file);
    result.set(wheel.version, files);
  }
  return result;
}

function edgeKey(edge: RequirementEdge): string {
  return [
    edge.requirement.normalizedName,
    edge.requirement.specifier,
    edge.requirement.extras.join(','),
    edge.reason.requiredBy,
    edge.reason.raw,
    edge.constraint ? 'constraint' : 'requirement',
  ].join('\0');
}

function uniqueEdges(edges: RequirementEdge[]): RequirementEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = edgeKey(edge);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function selectUnlockedPackage(options: {
  cache: PythonMetadataCache;
  edges: RequirementEdge[];
  environment: ResolvedTargetEnvironment;
  getProject: (name: string) => Promise<PythonProjectIndex>;
  index: PythonIndexClient;
}): Promise<SelectedPackage> {
  const name = options.edges[0]!.requirement.normalizedName;
  const project = await options.getProject(name);
  const versions = filesByVersion(project, name);
  const specifier = combinedSpecifier(options.edges);
  const remaining = [...versions.keys()];

  for (;;) {
    const version = maxSatisfyingVersion(remaining, specifier);
    if (!version) {
      throw new Error(`No published wheel version satisfies ${specifier || 'any version'}`);
    }
    const file = selectWheel(
      versions.get(version) ?? [],
      options.environment,
      exactPin(options.edges)
    );
    if (!file) {
      remaining.splice(remaining.indexOf(version), 1);
      continue;
    }
    if (!wheelMatchesRequirementHashes(file, options.edges)) {
      remaining.splice(remaining.indexOf(version), 1);
      continue;
    }
    const metadata = (await options.index.getMetadata(file, options.cache)).metadata;
    if (
      metadata.requiresPython &&
      !environmentSatisfiesRequiresPython(options.environment, metadata.requiresPython)
    ) {
      remaining.splice(remaining.indexOf(version), 1);
      continue;
    }
    return {
      edges: options.edges,
      extras: [
        ...new Set(
          options.edges.flatMap((edge) => edge.requirement.extras).map(normalizePackageName)
        ),
      ].sort(),
      file,
      metadata,
      name,
      version,
    };
  }
}

function rootEdges(
  requirements: PythonRequirementInput[],
  environment: ResolvedTargetEnvironment
): RequirementEdge[] {
  return requirements.flatMap((input): RequirementEdge[] => {
    if (!markerApplies(input.requirement.marker, environment)) {
      return [];
    }
    return [
      {
        constraint: input.constraint,
        hashes: input.hashes,
        reason: {
          raw: input.requirement.raw,
          requiredBy: input.requiredBy,
          sourcePath: input.sourcePath,
          type: input.sourcePath === 'workspace-targets' ? 'target' : 'requirement',
        },
        requirement: input.requirement,
      },
    ];
  });
}

function dependencyEdges(
  selected: Map<string, SelectedPackage>,
  environment: ResolvedTargetEnvironment
): RequirementEdge[] {
  const edges: RequirementEdge[] = [];
  for (const parent of selected.values()) {
    for (const raw of parent.metadata.requiresDist) {
      const parsed = parseRequirement(raw);
      if (!parsed.ok) {
        throw new Error(
          `${parent.name}@${parent.version} has invalid Requires-Dist "${raw}": ${parsed.reason}`
        );
      }
      if (parsed.requirement.url) {
        throw new Error(
          `${parent.name}@${parent.version} uses unsupported direct URL dependency: ${raw}`
        );
      }
      if (!markerApplies(parsed.requirement.marker, environment, parent.extras)) {
        continue;
      }
      edges.push({
        constraint: false,
        hashes: [],
        reason: {
          raw,
          requiredBy: `${parent.name}@${parent.version}`,
          sourcePath: parent.file.url,
          type: 'dependency',
        },
        requirement: parsed.requirement,
      });
    }
  }
  return edges;
}

function selectionSignature(selected: Map<string, SelectedPackage>): string {
  return [...selected.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((item) => `${item.name}@${item.version}[${item.extras.join(',')}]`)
    .join('|');
}

async function resolveUnlockedEnvironment(options: {
  cache: PythonMetadataCache;
  environment: ResolvedTargetEnvironment;
  index: PythonIndexClient;
  requirements: PythonRequirementInput[];
}): Promise<{ artifacts: ResolvedPythonArtifact[]; errors: PythonResolutionError[] }> {
  const errors: PythonResolutionError[] = [];
  const projects = new Map<string, Promise<PythonProjectIndex>>();
  const getProject = (name: string): Promise<PythonProjectIndex> => {
    const existing = projects.get(name);
    if (existing) {
      return existing;
    }
    const request = options.index.getProject(name);
    projects.set(name, request);
    return request;
  };
  let roots: RequirementEdge[];
  try {
    roots = rootEdges(options.requirements, options.environment);
  } catch (error) {
    return {
      artifacts: [],
      errors: [{ environment: options.environment.name, reason: (error as Error).message }],
    };
  }
  let selected = new Map<string, SelectedPackage>();
  const seenSignatures = new Set<string>();

  for (let round = 0; round < 100; round += 1) {
    let allEdges: RequirementEdge[];
    try {
      allEdges = uniqueEdges([...roots, ...dependencyEdges(selected, options.environment)]);
    } catch (error) {
      errors.push({ environment: options.environment.name, reason: (error as Error).message });
      return { artifacts: [], errors };
    }
    const groups = new Map<string, RequirementEdge[]>();
    for (const edge of allEdges) {
      const group = groups.get(edge.requirement.normalizedName) ?? [];
      group.push(edge);
      groups.set(edge.requirement.normalizedName, group);
    }
    const next = new Map<string, SelectedPackage>();
    for (const [name, edges] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
      if (!edges.some((edge) => !edge.constraint)) {
        continue;
      }
      try {
        next.set(
          name,
          await selectUnlockedPackage({
            cache: options.cache,
            edges,
            environment: options.environment,
            getProject,
            index: options.index,
          })
        );
      } catch (error) {
        const first = edges.find((edge) => !edge.constraint) ?? edges[0]!;
        errors.push({
          environment: options.environment.name,
          name,
          raw: first.reason.raw,
          reason: (error as Error).message,
          requiredBy: first.reason.requiredBy,
        });
      }
    }
    if (errors.length > 0) {
      return { artifacts: [], errors };
    }
    const signature = selectionSignature(next);
    if (signature === selectionSignature(selected)) {
      selected = next;
      break;
    }
    if (seenSignatures.has(signature)) {
      return {
        artifacts: [],
        errors: [
          {
            environment: options.environment.name,
            reason: 'Simplified Python resolution oscillated between incompatible selections',
          },
        ],
      };
    }
    seenSignatures.add(signature);
    selected = next;
    if (round === 99) {
      return {
        artifacts: [],
        errors: [
          {
            environment: options.environment.name,
            reason: 'Simplified Python resolution did not reach a fixed point',
          },
        ],
      };
    }
  }

  return {
    artifacts: [...selected.values()].map((item) => ({
      approximate: true,
      environment: options.environment.name,
      file: item.file,
      metadata: item.metadata,
      name: item.name,
      reasons: item.edges.filter((edge) => !edge.constraint).map((edge) => edge.reason),
      version: item.version,
    })),
    errors,
  };
}

function lockedFileToIndexFile(file: PythonLockedPackage['wheels'][number]): PythonIndexFile {
  return {
    filename: file.filename,
    hashes: file.hashes,
    url: file.url,
    ...(file.size !== undefined ? { size: file.size } : {}),
  };
}

function lockedPackageArtifact(
  pkg: PythonLockedPackage,
  lock: PythonLockInput,
  environment: ResolvedTargetEnvironment
): ResolvedPythonArtifact {
  if (!pkg.version) {
    throw new Error(`Locked registry package ${pkg.name} has no version`);
  }
  if (pkg.requiresPython && !environmentSatisfiesRequiresPython(environment, pkg.requiresPython)) {
    throw new Error(`Locked version requires Python ${pkg.requiresPython}`);
  }
  const file = selectWheel(pkg.wheels.map(lockedFileToIndexFile), environment, true);
  if (!file) {
    throw new Error('Locked package has no compatible wheel');
  }
  return {
    approximate: false,
    environment: environment.name,
    file,
    name: pkg.name,
    reasons: [
      {
        raw: `${pkg.name}==${pkg.version}`,
        requiredBy: `lockfile:${lock.sourcePath}`,
        sourcePath: lock.sourcePath,
        type: 'locked',
      },
    ],
    version: pkg.version,
  };
}

function dependencyCandidates(
  lock: PythonLockInput,
  dependency: PythonLockedPackage['dependencies'][number]
): PythonLockedPackage[] {
  return lock.packages.filter(
    (pkg) =>
      pkg.name === dependency.name &&
      (dependency.version === undefined || pkg.version === dependency.version) &&
      (dependency.source === undefined || pkg.source === dependency.source)
  );
}

function uvPackagesForEnvironment(
  lock: PythonLockInput,
  environment: ResolvedTargetEnvironment,
  includeDev: boolean
): PythonLockedPackage[] {
  const roots = lock.packages.filter((pkg) => pkg.sourceKind !== 'registry');
  if (roots.length === 0) {
    return lock.packages.filter((pkg) => pkg.sourceKind === 'registry');
  }
  const selected = new Set<PythonLockedPackage>();
  const activeExtras = new Map<PythonLockedPackage, Set<string>>();
  const queue = roots.map((pkg) => ({ extras: lock.extras, pkg }));
  while (queue.length > 0) {
    const { extras, pkg } = queue.shift()!;
    const knownExtras = activeExtras.get(pkg) ?? new Set<string>();
    const newExtras = extras.filter((extra) => !knownExtras.has(extra));
    const firstVisit = !selected.has(pkg);
    if (!firstVisit && newExtras.length === 0) {
      continue;
    }
    selected.add(pkg);
    newExtras.forEach((extra) => knownExtras.add(extra));
    activeExtras.set(pkg, knownExtras);
    const optionalDependencies = newExtras.flatMap((extra) =>
      Object.entries(pkg.optionalDependencies)
        .filter(([group]) => normalizePackageName(group) === extra)
        .flatMap(([, dependencies]) => dependencies)
    );
    const dependencies = [
      ...(firstVisit ? pkg.dependencies : []),
      ...(firstVisit && includeDev ? Object.values(pkg.devDependencies).flat() : []),
      ...optionalDependencies,
    ];
    for (const dependency of dependencies) {
      if (!markerApplies(dependency.marker, environment, [...knownExtras])) {
        continue;
      }
      const candidates = dependencyCandidates(lock, dependency);
      if (candidates.length !== 1) {
        throw new Error(
          `${lock.sourcePath} dependency ${dependency.name} resolves to ${String(candidates.length)} locked packages`
        );
      }
      queue.push({ extras: dependency.extras ?? [], pkg: candidates[0]! });
    }
  }
  return [...selected].filter((pkg) => pkg.sourceKind === 'registry');
}

function pylockPackagesForEnvironment(
  lock: PythonLockInput,
  environment: ResolvedTargetEnvironment,
  includeDev: boolean
): PythonLockedPackage[] {
  const dependencyGroups = includeDev
    ? [...new Set([...lock.defaultGroups, ...lock.dependencyGroups])]
    : lock.defaultGroups;
  return lock.packages.filter(
    (pkg) =>
      pkg.sourceKind === 'registry' && markerApplies(pkg.marker, environment, [], dependencyGroups)
  );
}

function resolveLockedEnvironment(
  lockfiles: PythonLockInput[],
  environment: ResolvedTargetEnvironment,
  includeDev: boolean
): { artifacts: ResolvedPythonArtifact[]; errors: PythonResolutionError[] } {
  const artifacts: ResolvedPythonArtifact[] = [];
  const errors: PythonResolutionError[] = [];
  for (const lock of lockfiles) {
    if (
      lock.requiresPython &&
      !environmentSatisfiesRequiresPython(environment, lock.requiresPython)
    ) {
      errors.push({
        environment: environment.name,
        reason: `Lockfile ${lock.sourcePath} requires Python ${lock.requiresPython}`,
      });
      continue;
    }
    let packages: PythonLockedPackage[];
    try {
      packages =
        lock.format === 'uv'
          ? uvPackagesForEnvironment(lock, environment, includeDev)
          : pylockPackagesForEnvironment(lock, environment, includeDev);
    } catch (error) {
      errors.push({ environment: environment.name, reason: (error as Error).message });
      continue;
    }
    const versionsByName = new Map<string, Set<string>>();
    for (const pkg of packages) {
      if (pkg.version) {
        const versions = versionsByName.get(pkg.name) ?? new Set<string>();
        versions.add(pkg.version);
        versionsByName.set(pkg.name, versions);
      }
    }
    for (const [name, versions] of versionsByName) {
      if (versions.size > 1) {
        errors.push({
          environment: environment.name,
          name,
          reason: `${lock.sourcePath} selects multiple versions for one environment: ${[...versions].join(', ')}`,
        });
      }
    }
    if (errors.length > 0) {
      continue;
    }
    for (const pkg of packages) {
      try {
        artifacts.push(lockedPackageArtifact(pkg, lock, environment));
      } catch (error) {
        errors.push({
          environment: environment.name,
          name: pkg.name,
          reason: `${lock.sourcePath}: ${(error as Error).message}`,
        });
      }
    }
  }
  return { artifacts, errors };
}

export async function resolvePython(
  options: ResolvePythonOptions
): Promise<PythonResolutionResult> {
  const environments = options.environments.map(resolveTargetEnvironment);
  const artifacts: ResolvedPythonArtifact[] = [];
  const errors: PythonResolutionError[] = [];
  for (const environment of environments) {
    const locked = resolveLockedEnvironment(
      options.lockfiles ?? [],
      environment,
      options.includeDev === true
    );
    errors.push(...locked.errors);
    const unlocked = await resolveUnlockedEnvironment({
      cache: options.cache,
      environment,
      index: options.index,
      requirements: options.requirements ?? [],
    });
    errors.push(...unlocked.errors);
    const environmentArtifacts = [...locked.artifacts, ...unlocked.artifacts];
    const versionsByName = new Map<string, Set<string>>();
    for (const artifact of environmentArtifacts) {
      const versions = versionsByName.get(artifact.name) ?? new Set<string>();
      versions.add(artifact.version);
      versionsByName.set(artifact.name, versions);
    }
    for (const [name, versions] of versionsByName) {
      if (versions.size > 1) {
        errors.push({
          environment: environment.name,
          name,
          reason: `Locked and unlocked inputs select conflicting versions: ${[...versions].join(', ')}`,
        });
      }
    }
    artifacts.push(...environmentArtifacts);
  }
  return {
    approximate: artifacts.some((artifact) => artifact.approximate),
    artifacts,
    environments,
    errors,
  };
}
