import path from 'node:path';
import type {
  NpmSecurityAdvisoryFinding,
  NpmSecurityReport,
  NpmStaticSecurityFinding,
  PackageSecurityAdvisoryFinding,
} from '../types.js';
import * as fs from './fs.js';
import type { PythonSecurityReport } from './python/security.js';

export const npmSecurityDeltaReportFileName = 'security-delta.json';
export const pythonSecurityDeltaReportFileName = 'python-security-delta.json';

export type SecurityDeltaComparisonStatus = 'baseline-created' | 'compared' | 'unavailable';

export interface SecurityFindingChanges<T> {
  added: T[];
  current: number;
  removed: T[];
}

export interface SecurityDeltaComparison {
  status: SecurityDeltaComparisonStatus;
  previousGeneratedAt?: string;
  reason?: 'current-scan-incomplete' | 'no-successful-baseline';
}

export interface NpmSecurityDeltaReport {
  advisories: SecurityFindingChanges<NpmSecurityAdvisoryFinding>;
  comparison: SecurityDeltaComparison;
  generatedAt: string;
  lifecycleScripts: SecurityFindingChanges<NpmStaticSecurityFinding>;
  schemaVersion: 1;
  summary: {
    added: number;
    current: number;
    removed: number;
  };
}

export interface PythonSecurityDeltaReport {
  advisories: SecurityFindingChanges<PackageSecurityAdvisoryFinding>;
  comparison: SecurityDeltaComparison;
  generatedAt: string;
  schemaVersion: 1;
  summary: {
    added: number;
    current: number;
    removed: number;
  };
}

function advisoryKey(finding: PackageSecurityAdvisoryFinding): string {
  return [finding.type, finding.name, finding.version, finding.id].join('\0');
}

function lifecycleScriptKey(finding: NpmStaticSecurityFinding): string {
  return [finding.name, finding.version, finding.sha256, finding.field, finding.value].join('\0');
}

function findingChanges<T>(
  current: T[],
  previous: T[],
  key: (finding: T) => string,
  compare: boolean
): SecurityFindingChanges<T> {
  if (!compare) {
    return { added: [], current: current.length, removed: [] };
  }

  const currentByKey = new Map(current.map((finding) => [key(finding), finding]));
  const previousByKey = new Map(previous.map((finding) => [key(finding), finding]));
  const added = [...currentByKey]
    .filter(([findingKey]) => !previousByKey.has(findingKey))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, finding]) => finding);
  const removed = [...previousByKey]
    .filter(([findingKey]) => !currentByKey.has(findingKey))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, finding]) => finding);

  return { added, current: current.length, removed };
}

function comparisonFor(
  current: { errors: string[]; generatedAt: string; ok: boolean },
  previous:
    | { errors: string[]; generatedAt: string; ok: boolean; schemaVersion: number }
    | undefined
): SecurityDeltaComparison {
  if (current.errors.length > 0) {
    return {
      status: 'unavailable',
      ...(previous ? { previousGeneratedAt: previous.generatedAt } : {}),
      reason: 'current-scan-incomplete',
    };
  }
  if (previous?.schemaVersion === 1 && previous.ok && previous.errors.length === 0) {
    return { previousGeneratedAt: previous.generatedAt, status: 'compared' };
  }
  if (current.ok) {
    return { status: 'baseline-created' };
  }
  return { reason: 'no-successful-baseline', status: 'unavailable' };
}

function npmWarningAdvisories(report: NpmSecurityReport): NpmSecurityAdvisoryFinding[] {
  return report.advisories.filter((finding) => finding.severity === 'warning');
}

function npmUnapprovedLifecycleScripts(report: NpmSecurityReport): NpmStaticSecurityFinding[] {
  return report.staticFindings.filter(
    (finding) =>
      finding.type === 'lifecycle-script' && finding.severity === 'warning' && !finding.allowed
  );
}

function pythonWarningAdvisories(report: PythonSecurityReport): PackageSecurityAdvisoryFinding[] {
  return report.advisories.filter((finding) => finding.severity === 'warning');
}

export function createNpmSecurityDeltaReport(
  current: NpmSecurityReport,
  previous?: NpmSecurityReport
): NpmSecurityDeltaReport {
  const comparison = comparisonFor(current, previous);
  const compare = comparison.status === 'compared';
  const advisories = findingChanges(
    npmWarningAdvisories(current),
    previous ? npmWarningAdvisories(previous) : [],
    advisoryKey,
    compare
  );
  const lifecycleScripts = findingChanges(
    npmUnapprovedLifecycleScripts(current),
    previous ? npmUnapprovedLifecycleScripts(previous) : [],
    lifecycleScriptKey,
    compare
  );

  return {
    advisories,
    comparison,
    generatedAt: current.generatedAt,
    lifecycleScripts,
    schemaVersion: 1,
    summary: {
      added: advisories.added.length + lifecycleScripts.added.length,
      current: advisories.current + lifecycleScripts.current,
      removed: advisories.removed.length + lifecycleScripts.removed.length,
    },
  };
}

export function createPythonSecurityDeltaReport(
  current: PythonSecurityReport,
  previous?: PythonSecurityReport
): PythonSecurityDeltaReport {
  const comparison = comparisonFor(current, previous);
  const advisories = findingChanges(
    pythonWarningAdvisories(current),
    previous ? pythonWarningAdvisories(previous) : [],
    advisoryKey,
    comparison.status === 'compared'
  );

  return {
    advisories,
    comparison,
    generatedAt: current.generatedAt,
    schemaVersion: 1,
    summary: {
      added: advisories.added.length,
      current: advisories.current,
      removed: advisories.removed.length,
    },
  };
}

export async function writeNpmSecurityDeltaReport(
  bundleDir: string,
  report: NpmSecurityDeltaReport
): Promise<void> {
  await fs.writeJsonAtomic(path.join(bundleDir, npmSecurityDeltaReportFileName), report, {
    spaces: 2,
  });
}

export async function writePythonSecurityDeltaReport(
  bundleDir: string,
  report: PythonSecurityDeltaReport
): Promise<void> {
  await fs.writeJsonAtomic(path.join(bundleDir, pythonSecurityDeltaReportFileName), report, {
    spaces: 2,
  });
}
