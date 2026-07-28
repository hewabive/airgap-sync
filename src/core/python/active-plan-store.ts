import path from 'node:path';
import { semanticDigest } from '../canonical-json.js';
import * as fs from '../fs.js';
import {
  createPythonEnvironmentPlan,
  serializePythonEnvironmentPlan,
  type PythonEnvironmentPlan,
} from './environment-plan.js';
import type { PythonPlannerEvidence } from './application-planner.js';
import {
  pythonApplicationPlanPath,
  pythonApplicationTargetId,
  pythonPlatformPylockPath,
} from './application-paths.js';
import { comparePythonEnvironmentPlans, type PythonPlanDiffReport } from './plan-diff.js';
import { parsePylock } from './pylock.js';

export interface StoredPythonPlanEvidence {
  digest: string;
  glibc?: string;
  path: string;
  platformFamilyId: string;
  platformTarget: string;
  pythonMinor: string;
}

export interface StoredPythonApplicationPlanManifest {
  diffPath: string;
  evidence: StoredPythonPlanEvidence[];
  planId: string;
  planPath: string;
  schemaVersion: 1;
  targetId: string;
  targetIndex: number;
}

export interface ActivePythonApplicationPlan {
  diff: PythonPlanDiffReport;
  evidence: PythonPlannerEvidence[];
  manifest: StoredPythonApplicationPlanManifest;
  plan: PythonEnvironmentPlan;
}

export interface WriteActivePythonApplicationPlanOptions {
  evidence: PythonPlannerEvidence[];
  generatedAt?: string;
  plan: PythonEnvironmentPlan;
  targetId?: string;
  targetIndex: number;
  workspaceDir: string;
}

const activePlansDirectory = path.join('.airgap-sync', 'python-plans');

export function activePythonApplicationPlanDirectory(
  workspaceDir: string,
  targetId: string
): string {
  pythonApplicationPlanPath(targetId);
  return path.join(workspaceDir, activePlansDirectory, targetId);
}

async function readOptionalPlan(planPath: string): Promise<PythonEnvironmentPlan | undefined> {
  if (!(await fs.pathExists(planPath))) {
    return undefined;
  }
  const value = await fs.readJson<PythonEnvironmentPlan>(planPath);
  if ((value as { schemaVersion?: unknown }).schemaVersion === 1) {
    return undefined;
  }
  return createPythonEnvironmentPlan(value);
}

export async function writeActivePythonApplicationPlan(
  options: WriteActivePythonApplicationPlanOptions
): Promise<{
  diff: PythonPlanDiffReport;
  manifest: StoredPythonApplicationPlanManifest;
}> {
  const targetId =
    options.targetId ??
    pythonApplicationTargetId(options.plan.application.name, options.plan.coverage.policy.id);
  const directory = activePythonApplicationPlanDirectory(options.workspaceDir, targetId);
  const planPath = path.join(directory, 'environment-plan.json');
  const previous = await readOptionalPlan(planPath);
  const evidence: StoredPythonPlanEvidence[] = [];
  for (const item of options.evidence) {
    const planPlatform = options.plan.platforms.find(
      (platform) =>
        platform.platformFamilyId === item.platformFamilyId &&
        platform.pythonMinor === item.pythonMinor
    );
    if (!planPlatform) {
      throw new Error(
        `Resolver evidence has no matching plan platform: ${item.platformFamilyId} / Python ${item.pythonMinor}`
      );
    }
    const relativePath =
      planPlatform.pylockPath ?? pythonPlatformPylockPath(item.platformFamilyId, item.pythonMinor);
    if (path.posix.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
      throw new Error(`Unsafe active Python lock path: ${relativePath}`);
    }
    await fs.writeFileAtomic(path.join(directory, relativePath), item.pylock.content);
    evidence.push({
      digest: item.pylock.digest,
      ...(item.glibc ? { glibc: item.glibc } : {}),
      path: relativePath,
      platformFamilyId: item.platformFamilyId,
      platformTarget: item.pylock.platformTarget,
      pythonMinor: item.pythonMinor,
    });
  }
  const manifest: StoredPythonApplicationPlanManifest = {
    diffPath: 'plan-diff.json',
    evidence: evidence.sort((left, right) =>
      left.platformFamilyId.localeCompare(right.platformFamilyId)
    ),
    planId: options.plan.planId,
    planPath: 'environment-plan.json',
    schemaVersion: 1,
    targetId,
    targetIndex: options.targetIndex,
  };
  const diff = comparePythonEnvironmentPlans(
    previous,
    options.plan,
    options.generatedAt ?? new Date().toISOString()
  );
  await Promise.all([
    fs.writeFileAtomic(planPath, serializePythonEnvironmentPlan(options.plan)),
    fs.writeJsonAtomic(path.join(directory, 'active-plan.json'), manifest, { spaces: 2 }),
    fs.writeJsonAtomic(path.join(directory, 'plan-diff.json'), diff, { spaces: 2 }),
  ]);
  return { diff, manifest };
}

export async function readActivePythonApplicationPlan(
  workspaceDir: string,
  targetId: string
): Promise<ActivePythonApplicationPlan> {
  const directory = activePythonApplicationPlanDirectory(workspaceDir, targetId);
  const manifest = await fs.readJson<StoredPythonApplicationPlanManifest>(
    path.join(directory, 'active-plan.json')
  );
  if (
    (manifest as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    manifest.targetId !== targetId ||
    manifest.diffPath !== 'plan-diff.json' ||
    manifest.planPath !== 'environment-plan.json'
  ) {
    throw new Error(`Invalid active Python application plan manifest: ${targetId}`);
  }
  const plan = createPythonEnvironmentPlan(
    await fs.readJson<PythonEnvironmentPlan>(path.join(directory, manifest.planPath))
  );
  if (plan.planId !== manifest.planId) {
    throw new Error(`Active Python application plan ID mismatch: ${targetId}`);
  }
  const diff = await fs.readJson<PythonPlanDiffReport>(path.join(directory, manifest.diffPath));
  if ((diff as { schemaVersion?: unknown }).schemaVersion !== 1 || diff.planId.to !== plan.planId) {
    throw new Error(`Invalid active Python plan diff: ${targetId}`);
  }
  const evidence: PythonPlannerEvidence[] = [];
  for (const item of manifest.evidence) {
    if (path.posix.isAbsolute(item.path) || item.path.split('/').includes('..')) {
      throw new Error(`Unsafe active Python evidence path: ${item.path}`);
    }
    const content = await fs.readFile(path.join(directory, item.path), 'utf8');
    if (semanticDigest(content) !== item.digest) {
      throw new Error(`Active Python lock digest mismatch: ${item.path}`);
    }
    evidence.push({
      ...(item.glibc ? { glibc: item.glibc } : {}),
      platformFamilyId: item.platformFamilyId as PythonPlannerEvidence['platformFamilyId'],
      pylock: {
        content,
        digest: item.digest,
        lock: parsePylock(content, item.path),
        platformTarget: item.platformTarget,
      },
      pythonMinor: item.pythonMinor,
    });
  }
  return { diff, evidence, manifest, plan };
}
