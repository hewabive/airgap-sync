import { canonicalJson, semanticDigest } from '../canonical-json.js';
import type { PythonApplicationIntent } from './application-intent.js';
import type { PlatformCoveragePolicy } from './coverage-policy.js';
import type { PlatformFamily } from './platform-family.js';

export interface PythonPlanWheel {
  filename: string;
  package: string;
  platforms: string[];
  sha256: string;
  size?: number;
  url: string;
  version: string;
}

export interface PythonLockedPackagePlan {
  dependencies: string[];
  name: string;
  version: string;
  wheels: string[];
}

export interface PythonPlatformPlan {
  packages: PythonLockedPackagePlan[];
  platformFamilyId: string;
  pylockPath?: string;
  pythonMinor: string;
  rejectedReasons: string[];
  requirementsLockPath?: string;
  requiresPython: string;
  status: 'rejected' | 'supported';
  supportBoundary?: {
    glibc?: string;
  };
}

export interface PythonEnvironmentPlanPresentation {
  rejectedCandidateSummaries?: string[];
  warnings?: string[];
}

export interface PythonPlanTransferArtifact {
  filename: string;
  kind: 'cpython' | 'license' | 'uv';
  license: {
    spdx: string;
    url: string;
  };
  platforms: string[];
  publication: {
    owner: string;
    package: string;
    version: string;
  };
  sha256: string;
  size?: number;
  sourceUrl: string;
  version: string;
}

export interface PythonRuntimeContract {
  platforms: {
    implementation: 'CPython';
    platformFamilyId: string;
    provisionedExternally: true;
    pythonMinor: string;
    requiresPython: string;
    systemPrerequisites: string[];
  }[];
}

export interface PythonEnvironmentPlan {
  application: {
    name: string;
    version: string;
  };
  coverage: {
    digest: string;
    families: PlatformFamily[];
    policy: PlatformCoveragePolicy;
  };
  createdAt: string;
  intent: PythonApplicationIntent;
  planId: string;
  platforms: PythonPlatformPlan[];
  preferredPythonMinor?: string;
  presentation?: PythonEnvironmentPlanPresentation;
  publication?: {
    applicationArtifactOwner: string;
    pythonPackageOwner: string;
  };
  resolver: {
    cutoff?: string;
    engine: 'uv';
    policyVersion: number;
    version: string;
  };
  runtimeArtifacts?: PythonPlanTransferArtifact[];
  runtimeContract?: PythonRuntimeContract;
  schemaVersion: 1;
  wheels: PythonPlanWheel[];
}

export type PythonEnvironmentPlanInput = Omit<PythonEnvironmentPlan, 'planId'> & {
  planId?: string;
};

export function pythonEnvironmentPlanSemanticContent(
  plan: PythonEnvironmentPlanInput
): Omit<PythonEnvironmentPlan, 'createdAt' | 'planId' | 'presentation'> {
  return {
    application: plan.application,
    coverage: plan.coverage,
    intent: plan.intent,
    platforms: plan.platforms,
    ...(plan.preferredPythonMinor ? { preferredPythonMinor: plan.preferredPythonMinor } : {}),
    ...(plan.publication ? { publication: plan.publication } : {}),
    resolver: plan.resolver,
    ...(plan.runtimeArtifacts ? { runtimeArtifacts: plan.runtimeArtifacts } : {}),
    ...(plan.runtimeContract ? { runtimeContract: plan.runtimeContract } : {}),
    schemaVersion: plan.schemaVersion,
    wheels: plan.wheels,
  };
}

export function pythonEnvironmentPlanId(plan: PythonEnvironmentPlanInput): string {
  return semanticDigest(pythonEnvironmentPlanSemanticContent(plan));
}

export function createPythonEnvironmentPlan(
  plan: PythonEnvironmentPlanInput
): PythonEnvironmentPlan {
  const planId = pythonEnvironmentPlanId(plan);
  if (plan.planId !== undefined && plan.planId !== planId) {
    throw new Error(`Python environment plan ID mismatch: expected ${planId}`);
  }
  return {
    ...plan,
    planId,
  };
}

export function serializePythonEnvironmentPlan(plan: PythonEnvironmentPlan): string {
  return `${canonicalJson(plan)}\n`;
}
