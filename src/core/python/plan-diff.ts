import type { PythonEnvironmentPlan } from './environment-plan.js';

export interface PythonPlanDiffReport {
  application: {
    from?: string;
    to: string;
  };
  artifacts: {
    added: string[];
    removed: string[];
  };
  changed: boolean;
  generatedAt: string;
  packages: {
    added: string[];
    changed: {
      from: string;
      name: string;
      platformFamilyId: string;
      to: string;
    }[];
    removed: string[];
  };
  planId: {
    from?: string;
    to: string;
  };
  prerequisites: {
    added: string[];
    removed: string[];
  };
  runtime: {
    from: string[];
    to: string[];
  };
  schemaVersion: 1;
}

function packageVersions(plan: PythonEnvironmentPlan): Map<string, string> {
  const result = new Map<string, string>();
  for (const platform of plan.platforms) {
    for (const pkg of platform.packages) {
      result.set(`${platform.platformFamilyId}\0${pkg.name}`, pkg.version);
    }
  }
  return result;
}

function artifactIdentities(plan: PythonEnvironmentPlan): Set<string> {
  return new Set(plan.wheels.map((wheel) => `wheel:${wheel.sha256}:${wheel.filename}`));
}

function runtimeIdentities(plan: PythonEnvironmentPlan): string[] {
  return plan.platforms
    .map(
      (platform) =>
        `${platform.platformFamilyId}: CPython ${platform.requiresPython}${
          platform.supportBoundary?.glibc ? `, glibc >= ${platform.supportBoundary.glibc}` : ''
        }`
    )
    .sort();
}

function prerequisites(plan: PythonEnvironmentPlan): Set<string> {
  return new Set(
    (plan.runtimeContract?.platforms ?? []).flatMap((platform) =>
      platform.systemPrerequisites.map(
        (prerequisite) => `${platform.platformFamilyId}: ${prerequisite}`
      )
    )
  );
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

export function comparePythonEnvironmentPlans(
  previous: PythonEnvironmentPlan | undefined,
  next: PythonEnvironmentPlan,
  generatedAt = new Date().toISOString()
): PythonPlanDiffReport {
  const beforePackages = previous ? packageVersions(previous) : new Map<string, string>();
  const afterPackages = packageVersions(next);
  const addedPackages: string[] = [];
  const changedPackages: PythonPlanDiffReport['packages']['changed'] = [];
  for (const [key, version] of afterPackages) {
    const previousVersion = beforePackages.get(key);
    const [platformFamilyId, name] = key.split('\0') as [string, string];
    if (previousVersion === undefined) {
      addedPackages.push(`${platformFamilyId}: ${name}==${version}`);
    } else if (previousVersion !== version) {
      changedPackages.push({
        from: previousVersion,
        name,
        platformFamilyId,
        to: version,
      });
    }
  }
  const removedPackages = [...beforePackages]
    .filter(([key]) => !afterPackages.has(key))
    .map(([key, version]) => {
      const [platformFamilyId, name] = key.split('\0') as [string, string];
      return `${platformFamilyId}: ${name}==${version}`;
    })
    .sort();
  const beforeArtifacts = previous ? artifactIdentities(previous) : new Set<string>();
  const afterArtifacts = artifactIdentities(next);
  const beforePrerequisites = previous ? prerequisites(previous) : new Set<string>();
  const afterPrerequisites = prerequisites(next);
  const report: PythonPlanDiffReport = {
    application: {
      ...(previous
        ? { from: `${previous.application.name}==${previous.application.version}` }
        : {}),
      to: `${next.application.name}==${next.application.version}`,
    },
    artifacts: {
      added: difference(afterArtifacts, beforeArtifacts),
      removed: difference(beforeArtifacts, afterArtifacts),
    },
    changed: previous?.planId !== next.planId,
    generatedAt,
    packages: {
      added: addedPackages.sort(),
      changed: changedPackages.sort((left, right) => {
        const byPlatform = left.platformFamilyId.localeCompare(right.platformFamilyId);
        return byPlatform === 0 ? left.name.localeCompare(right.name) : byPlatform;
      }),
      removed: removedPackages,
    },
    planId: {
      ...(previous ? { from: previous.planId } : {}),
      to: next.planId,
    },
    prerequisites: {
      added: difference(afterPrerequisites, beforePrerequisites),
      removed: difference(beforePrerequisites, afterPrerequisites),
    },
    runtime: {
      from: previous ? runtimeIdentities(previous) : [],
      to: runtimeIdentities(next),
    },
    schemaVersion: 1,
  };
  return report;
}

export function formatPythonPlanDiff(report: PythonPlanDiffReport): string {
  if (!report.planId.from) {
    return `New plan ${report.planId.to}: ${String(report.packages.added.length)} package branches, ${String(report.artifacts.added.length)} artifacts`;
  }
  if (!report.changed) {
    return `Plan unchanged: ${report.planId.to}`;
  }
  return [
    `Plan changed: ${report.planId.from} -> ${report.planId.to}`,
    `Application: ${report.application.from ?? 'none'} -> ${report.application.to}`,
    `Packages: ${String(report.packages.added.length)} added, ${String(report.packages.changed.length)} changed, ${String(report.packages.removed.length)} removed`,
    `Artifacts: ${String(report.artifacts.added.length)} added, ${String(report.artifacts.removed.length)} removed`,
    `Prerequisites: ${String(report.prerequisites.added.length)} added, ${String(report.prerequisites.removed.length)} removed`,
  ].join('\n');
}
