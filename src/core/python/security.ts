import path from 'node:path';
import type { PackageSecurityAdvisoryFinding } from '../../types.js';
import {
  OsvBatchClient,
  osvFindings,
  type OsvClient,
  type OsvVulnerability,
} from '../advisories.js';
import { semanticDigest } from '../canonical-json.js';
import * as fs from '../fs.js';
import type { PythonSeedManifest } from './bundle.js';
import { normalizePackageName } from './names.js';

export const pythonSecurityReportFileName = 'python-security-report.json';
export const failedPythonSecurityReportFileName = 'python-security-report.failed.json';

export interface PythonSecurityPolicy {
  maxReportAgeHours: number;
}

export const defaultPythonSecurityPolicy: PythonSecurityPolicy = {
  maxReportAgeHours: 72,
};

export interface PythonSecurityReport {
  advisories: PackageSecurityAdvisoryFinding[];
  errors: string[];
  generatedAt: string;
  manifestSha256: string;
  ok: boolean;
  packageCount: number;
  policy: PythonSecurityPolicy;
  provider: {
    name: 'OSV';
    url: string;
  };
  schemaVersion: 1;
}

export interface PythonAdvisoryClient {
  query(packages: { name: string; version: string }[]): Promise<OsvVulnerability[][]>;
}

export class OsvPythonAdvisoryClient implements PythonAdvisoryClient {
  readonly #client: OsvClient;

  constructor(clientOrUrl: OsvClient | string = new OsvBatchClient(), timeoutMs = 30_000) {
    this.#client =
      typeof clientOrUrl === 'string' ? new OsvBatchClient(clientOrUrl, timeoutMs) : clientOrUrl;
  }

  query(packages: { name: string; version: string }[]): Promise<OsvVulnerability[][]> {
    return this.#client.query(packages.map((pkg) => ({ ...pkg, ecosystem: 'PyPI' })));
  }
}

export interface PythonSecurityConsoleSummary {
  blocking: number;
  blockingAdvisories: number;
  details: { level: 'error' | 'warning'; message: string }[];
  omitted: number;
  scannerErrors: number;
  warnings: number;
}

function normalizePolicy(policy: Partial<PythonSecurityPolicy> = {}): PythonSecurityPolicy {
  return {
    maxReportAgeHours: Math.max(
      1,
      policy.maxReportAgeHours ?? defaultPythonSecurityPolicy.maxReportAgeHours
    ),
  };
}

function packagesFromManifest(manifest: PythonSeedManifest): { name: string; version: string }[] {
  const packages = new Map<string, { name: string; version: string }>();
  for (const pkg of manifest.packages) {
    const name = normalizePackageName(pkg.name);
    const key = `${name}\0${pkg.version}`;
    if (!packages.has(key)) packages.set(key, { name, version: pkg.version });
  }
  return [...packages.values()].sort(
    (left, right) =>
      normalizePackageName(left.name).localeCompare(normalizePackageName(right.name)) ||
      left.version.localeCompare(right.version)
  );
}

function manifestHasCompleteHashes(manifest: PythonSeedManifest): boolean {
  return (
    (manifest as { schemaVersion?: unknown }).schemaVersion === 1 &&
    manifest.packages.every(
      (pkg) =>
        pkg.files.length > 0 && pkg.files.every((file) => /^[a-f0-9]{64}$/iu.test(file.sha256))
    )
  );
}

export async function scanPythonBundleSecurity(options: {
  advisoryClient?: PythonAdvisoryClient;
  generatedAt?: string;
  manifest: PythonSeedManifest;
  policy?: Partial<PythonSecurityPolicy>;
}): Promise<PythonSecurityReport> {
  const policy = normalizePolicy(options.policy);
  const packages = packagesFromManifest(options.manifest);
  const errors: string[] = [];
  if (!manifestHasCompleteHashes(options.manifest)) {
    errors.push(
      'Python security scanning requires a schemaVersion 1 manifest with SHA-256 for every wheel'
    );
  }

  const advisories: PackageSecurityAdvisoryFinding[] = [];
  try {
    const results = await (options.advisoryClient ?? new OsvPythonAdvisoryClient()).query(packages);
    advisories.push(...osvFindings(packages, results));
  } catch (error) {
    errors.push(`OSV: ${(error as Error).message}`);
  }

  return {
    advisories,
    errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    manifestSha256: semanticDigest(options.manifest),
    ok: errors.length === 0 && !advisories.some((finding) => finding.severity === 'error'),
    packageCount: packages.length,
    policy,
    provider: { name: 'OSV', url: 'https://api.osv.dev/v1/querybatch' },
    schemaVersion: 1,
  };
}

export function summarizePythonSecurityReport(
  report: PythonSecurityReport,
  options: { maxDetails?: number } = {}
): PythonSecurityConsoleSummary {
  const blockingAdvisories = report.advisories.filter((finding) => finding.severity === 'error');
  const warnings = report.advisories.filter((finding) => finding.severity === 'warning');
  const candidates: PythonSecurityConsoleSummary['details'] = [
    ...report.errors.map((error) => ({
      level: 'error' as const,
      message: `Scanner error: ${error}`,
    })),
    ...blockingAdvisories.map((finding) => ({
      level: 'error' as const,
      message: `${finding.type === 'malware' ? 'Malware' : 'Advisory'} [${finding.name}==${finding.version}] ${finding.id}${finding.summary ? `: ${finding.summary}` : ''}`,
    })),
    ...warnings.map((finding) => ({
      level: 'warning' as const,
      message: `Vulnerability [${finding.name}==${finding.version}] ${finding.id}${finding.summary ? `: ${finding.summary}` : ''}`,
    })),
  ];
  const maxDetails = Math.max(0, Math.floor(options.maxDetails ?? 20));
  return {
    blocking: report.errors.length + blockingAdvisories.length,
    blockingAdvisories: blockingAdvisories.length,
    details: candidates.slice(0, maxDetails),
    omitted: Math.max(0, candidates.length - maxDetails),
    scannerErrors: report.errors.length,
    warnings: warnings.length,
  };
}

export async function writePythonSecurityReport(
  bundleDir: string,
  report: PythonSecurityReport,
  options: { failed?: boolean } = {}
): Promise<void> {
  await fs.writeJsonAtomic(
    path.join(
      bundleDir,
      options.failed ? failedPythonSecurityReportFileName : pythonSecurityReportFileName
    ),
    report,
    { spaces: 2 }
  );
}

export async function assertPythonSecurityGate(
  bundleDir: string,
  manifest: PythonSeedManifest,
  options: { now?: Date } = {}
): Promise<PythonSecurityReport> {
  if (!manifestHasCompleteHashes(manifest)) {
    throw new Error('Refusing Python publication: manifest has no complete SHA-256 wheel set');
  }

  let report: PythonSecurityReport;
  try {
    report = await fs.readJson<PythonSecurityReport>(
      path.join(bundleDir, pythonSecurityReportFileName)
    );
  } catch (error) {
    throw new Error(
      `Refusing Python publication: ${pythonSecurityReportFileName} is missing or unreadable: ${(error as Error).message}`
    );
  }
  if ((report as { schemaVersion?: unknown }).schemaVersion !== 1 || !report.ok) {
    throw new Error('Refusing Python publication: security report did not pass');
  }
  if (report.manifestSha256 !== semanticDigest(manifest)) {
    throw new Error(
      `Refusing Python publication: security report does not match python-seed-manifest.json`
    );
  }
  const maxReportAgeHours = (report as { policy?: Partial<PythonSecurityPolicy> }).policy
    ?.maxReportAgeHours;
  if (
    typeof maxReportAgeHours !== 'number' ||
    !Number.isFinite(maxReportAgeHours) ||
    maxReportAgeHours < 1
  ) {
    throw new Error('Refusing Python publication: security report policy is invalid');
  }
  const reportTime = Date.parse(report.generatedAt);
  const ageMs = (options.now ?? new Date()).getTime() - reportTime;
  if (!Number.isFinite(reportTime) || ageMs < 0 || ageMs > maxReportAgeHours * 60 * 60 * 1000) {
    throw new Error(
      `Refusing Python publication: security report is older than ${String(maxReportAgeHours)} hours`
    );
  }
  return report;
}
