import { semanticDigest } from '../canonical-json.js';
import type { WorkspaceCpythonDistributionsTarget } from '../workspace.js';
import type { BuiltInPlatformFamilyId } from './platform-family.js';

export interface CpythonDistributionCandidate {
  filename: string;
  platformFamilyId: BuiltInPlatformFamilyId;
  provider: 'python-build-standalone';
  providerBuild: string;
  providerPublishedAt: string;
  pythonVersion: string;
  sha256: string;
  size: number;
  sourceUrl: string;
}

export interface SelectedCpythonDistribution extends CpythonDistributionCandidate {
  id: string;
  references: string[];
}

export interface CpythonDistributionTargetSelection {
  artifactIds: string[];
  target: WorkspaceCpythonDistributionsTarget;
  targetId: string;
}

export interface CpythonDistributionSelection {
  artifacts: SelectedCpythonDistribution[];
  generatedAt: string;
  targets: CpythonDistributionTargetSelection[];
}

interface ParsedStableVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseStableVersion(value: string): ParsedStableVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) {
    throw new Error(`CPython distribution version must be stable X.Y.Z: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function parseMinor(value: string): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)$/u.exec(value);
  if (!match) {
    throw new Error(`CPython distribution minor must be X.Y: ${value}`);
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function normalizeTimestamp(value: string): number {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`CPython provider publication time must be normalized ISO: ${value}`);
  }
  return timestamp.getTime();
}

function validateCandidate(candidate: CpythonDistributionCandidate): void {
  parseStableVersion(candidate.pythonVersion);
  normalizeTimestamp(candidate.providerPublishedAt);
  if (
    !candidate.filename ||
    candidate.filename.includes('/') ||
    candidate.filename.includes('\\')
  ) {
    throw new Error(`Unsafe CPython distribution filename: ${candidate.filename}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(candidate.sha256)) {
    throw new Error(`Invalid CPython distribution SHA-256: ${candidate.filename}`);
  }
  if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0) {
    throw new Error(`Invalid CPython distribution size: ${candidate.filename}`);
  }
  const url = new URL(candidate.sourceUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(
      `CPython distribution source URL must be credential-free HTTPS: ${url.toString()}`
    );
  }
}

export function cpythonDistributionArtifactId(candidate: CpythonDistributionCandidate): string {
  return semanticDigest({
    filename: candidate.filename,
    provider: candidate.provider,
    providerBuild: candidate.providerBuild,
    sha256: candidate.sha256,
  });
}

export function cpythonDistributionTargetId(target: WorkspaceCpythonDistributionsTarget): string {
  return `cpython-${semanticDigest(target).slice(0, 24)}`;
}

function candidateSort(
  left: CpythonDistributionCandidate,
  right: CpythonDistributionCandidate
): number {
  const leftVersion = parseStableVersion(left.pythonVersion);
  const rightVersion = parseStableVersion(right.pythonVersion);
  return (
    rightVersion.major - leftVersion.major ||
    rightVersion.minor - leftVersion.minor ||
    rightVersion.patch - leftVersion.patch ||
    normalizeTimestamp(right.providerPublishedAt) - normalizeTimestamp(left.providerPublishedAt) ||
    right.providerBuild.localeCompare(left.providerBuild) ||
    left.filename.localeCompare(right.filename)
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    groups.set(value, [...(groups.get(value) ?? []), item]);
  }
  return groups;
}

function selectTargetCandidates(
  target: WorkspaceCpythonDistributionsTarget,
  candidates: CpythonDistributionCandidate[],
  generatedAt: string
): CpythonDistributionCandidate[] {
  const generatedAtMs = normalizeTimestamp(generatedAt);
  const lower = parseMinor(target.series.from);
  const cutoff = generatedAtMs - target.builds.windowDays * 24 * 60 * 60 * 1000;
  const selected = new Map<string, CpythonDistributionCandidate>();

  for (const platformFamilyId of target.platforms) {
    const platformCandidates = candidates.filter((candidate) => {
      if (
        candidate.platformFamilyId !== platformFamilyId ||
        normalizeTimestamp(candidate.providerPublishedAt) > generatedAtMs
      ) {
        return false;
      }
      const version = parseStableVersion(candidate.pythonVersion);
      return (
        version.major === target.series.major &&
        (version.major > lower.major ||
          (version.major === lower.major && version.minor >= lower.minor))
      );
    });
    const byMinor = groupBy(platformCandidates, (candidate) => {
      const version = parseStableVersion(candidate.pythonVersion);
      return `${String(version.major)}.${String(version.minor)}`;
    });
    for (const minorCandidates of byMinor.values()) {
      const byPatch = groupBy(minorCandidates, (candidate) => candidate.pythonVersion);
      const patches = [...byPatch.entries()].sort(([left], [right]) => {
        const leftVersion = parseStableVersion(left);
        const rightVersion = parseStableVersion(right);
        return rightVersion.patch - leftVersion.patch;
      });
      for (const [, patchCandidates] of patches.slice(0, target.patches.latest)) {
        const builds = [...patchCandidates].sort(candidateSort);
        for (const [index, candidate] of builds.entries()) {
          if (index === 0 || normalizeTimestamp(candidate.providerPublishedAt) >= cutoff) {
            selected.set(cpythonDistributionArtifactId(candidate), candidate);
          }
        }
      }
    }
  }

  return [...selected.values()].sort(candidateSort);
}

export function selectCpythonDistributions(options: {
  candidates: CpythonDistributionCandidate[];
  generatedAt?: string;
  targets: WorkspaceCpythonDistributionsTarget[];
}): CpythonDistributionSelection {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  normalizeTimestamp(generatedAt);
  for (const candidate of options.candidates) {
    validateCandidate(candidate);
  }

  const artifacts = new Map<string, CpythonDistributionCandidate & { references: Set<string> }>();
  const targets = options.targets.map((target) => {
    const targetId = cpythonDistributionTargetId(target);
    const selected = selectTargetCandidates(target, options.candidates, generatedAt);
    const artifactIds = selected.map((candidate) => {
      const id = cpythonDistributionArtifactId(candidate);
      const current = artifacts.get(id);
      if (current) {
        current.references.add(targetId);
      } else {
        artifacts.set(id, { ...candidate, references: new Set([targetId]) });
      }
      return id;
    });
    return {
      artifactIds: [...new Set(artifactIds)].sort(),
      target,
      targetId,
    };
  });

  return {
    artifacts: [...artifacts.entries()]
      .map(([id, artifact]) => ({
        ...artifact,
        id,
        references: [...artifact.references].sort(),
      }))
      .sort(candidateSort),
    generatedAt,
    targets: targets.sort((left, right) => left.targetId.localeCompare(right.targetId)),
  };
}
