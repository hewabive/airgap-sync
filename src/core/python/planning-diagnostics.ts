import type { PlanPythonApplicationResult } from './application-planner.js';
import { compareVersions } from './pep440.js';

function compactReason(reason: string): string {
  const detail = reason.includes('\n') ? reason.slice(reason.indexOf('\n') + 1) : reason;
  const compact = detail.replace(/\s+/gu, ' ').trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}…` : compact;
}

export function formatPythonPlanningWarnings(
  result: Pick<PlanPythonApplicationResult, 'plan' | 'rejectedCandidates'>,
  reportPath: string
): string[] {
  const { plan } = result;
  const newer = result.rejectedCandidates.filter(
    (candidate) => compareVersions(candidate.applicationVersion, plan.application.version) > 0
  );
  const warnings: string[] = [];
  if (newer.length > 0) {
    const versions = [...new Set(newer.map((candidate) => candidate.applicationVersion))].sort(
      (left, right) => compareVersions(right, left)
    );
    warnings.push(
      `${plan.application.name}: selected ${plan.application.version}; rejected ${String(versions.length)} newer version(s), newest ${versions[0]!}.`
    );
    const newest = newer.filter((candidate) => candidate.applicationVersion === versions[0]);
    // Prefer the last attempted environment over an early, overly restrictive glibc baseline.
    const reason = newest.at(-1)?.reason;
    if (reason) {
      warnings.push(`Newest version: ${compactReason(reason.split(' | ').at(-1) ?? reason)}`);
    }
  }
  for (const skipped of plan.presentation?.skippedPythonMinors ?? []) {
    warnings.push(
      `${plan.application.name}==${plan.application.version}: skipped requested Python ${skipped.pythonMinor}. ${compactReason(skipped.reasons.at(-1) ?? 'No complete dependency tree was selected.')}`
    );
  }
  if (warnings.length > 0) {
    warnings.push(`Full planning diagnostics: ${reportPath}`);
  }
  return warnings;
}
