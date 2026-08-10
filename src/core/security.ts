import path from 'node:path';
import type {
  BundleManifest,
  NpmSecurityAdvisoryFinding,
  NpmSecurityPolicy,
  NpmSecurityReport,
  NpmStaticSecurityFinding,
  PackageManifest,
  ResolvedPackage,
} from '../types.js';
import { semanticDigest } from './canonical-json.js';
import * as fs from './fs.js';
import { parseDependencySpec } from './specs.js';
import { inspectPackageTarball, type TarballInspectionCache } from './tarball.js';
import {
  OsvBatchClient,
  osvFindings,
  type OsvClient,
  type OsvVulnerability,
} from './advisories.js';

export const defaultNpmSecurityPolicy: NpmSecurityPolicy = {
  allowPackages: [],
  maxReportAgeHours: 72,
  minReleaseAgeDays: 3,
  vulnerabilityResolutionPolicy: 'prefer-clean',
};

type NpmSecurityConsoleDetailLevel = 'error' | 'info' | 'warning';

interface NpmSecurityConsoleDetail {
  level: NpmSecurityConsoleDetailLevel;
  message: string;
}

export interface NpmSecurityConsoleSummary {
  approved: number;
  blocking: number;
  blockingAdvisories: number;
  blockingStatic: number;
  details: NpmSecurityConsoleDetail[];
  lifecycleScripts: number;
  omitted: number;
  scannerErrors: number;
  warningAdvisories: number;
  warningStatic: number;
  warnings: number;
}

export interface NpmAdvisoryClient {
  query(packages: { name: string; version: string }[]): Promise<OsvVulnerability[][]>;
}

export class OsvNpmAdvisoryClient implements NpmAdvisoryClient {
  readonly #client: OsvClient;

  constructor(clientOrUrl: OsvClient | string = new OsvBatchClient(), timeoutMs = 30_000) {
    this.#client =
      typeof clientOrUrl === 'string' ? new OsvBatchClient(clientOrUrl, timeoutMs) : clientOrUrl;
  }

  query(packages: { name: string; version: string }[]): Promise<OsvVulnerability[][]> {
    return this.#client.query(packages.map((pkg) => ({ ...pkg, ecosystem: 'npm' })));
  }
}

function packageApprovalId(pkg: Pick<ResolvedPackage, 'name' | 'sha256' | 'version'>): string {
  return `${pkg.name}@${pkg.version}#sha256:${pkg.sha256 ?? '<missing>'}`;
}

function staticFinding(
  pkg: ResolvedPackage & { sha256: string },
  policy: NpmSecurityPolicy,
  finding: Omit<NpmStaticSecurityFinding, 'allowed' | 'name' | 'sha256' | 'version'>
): NpmStaticSecurityFinding {
  return {
    ...finding,
    allowed: policy.allowPackages.includes(packageApprovalId(pkg)),
    name: pkg.name,
    sha256: pkg.sha256,
    version: pkg.version,
  };
}

function scanManifest(
  pkg: ResolvedPackage & { sha256: string },
  manifest: PackageManifest,
  policy: NpmSecurityPolicy
): NpmStaticSecurityFinding[] {
  const findings: NpmStaticSecurityFinding[] = [];
  for (const scriptName of ['preinstall', 'install', 'postinstall'] as const) {
    const command = manifest.scripts?.[scriptName];
    if (!command) continue;
    findings.push(
      staticFinding(pkg, policy, {
        field: `scripts.${scriptName}`,
        message: `${pkg.name}@${pkg.version} declares ${scriptName} lifecycle code`,
        severity: 'warning',
        type: 'lifecycle-script',
        value: command,
      })
    );
  }

  for (const [section, dependencies] of [
    ['dependencies', manifest.dependencies],
    ['optionalDependencies', manifest.optionalDependencies],
  ] as const) {
    for (const [name, specifier] of Object.entries(dependencies ?? {})) {
      if (!('reason' in parseDependencySpec(name, specifier, `${pkg.name}@${pkg.version}`))) {
        continue;
      }
      findings.push(
        staticFinding(pkg, policy, {
          field: `${section}.${name}`,
          message: `${pkg.name}@${pkg.version} declares a non-registry dependency`,
          severity: 'error',
          type: 'non-registry-dependency',
          value: specifier,
        })
      );
    }
  }
  return findings;
}

function normalizePolicy(policy: Partial<NpmSecurityPolicy> = {}): NpmSecurityPolicy {
  return {
    allowPackages: [...(policy.allowPackages ?? defaultNpmSecurityPolicy.allowPackages)].sort(),
    maxReportAgeHours: Math.max(
      1,
      policy.maxReportAgeHours ?? defaultNpmSecurityPolicy.maxReportAgeHours
    ),
    minReleaseAgeDays: Math.max(
      0,
      policy.minReleaseAgeDays ?? defaultNpmSecurityPolicy.minReleaseAgeDays
    ),
    vulnerabilityResolutionPolicy:
      policy.vulnerabilityResolutionPolicy ??
      defaultNpmSecurityPolicy.vulnerabilityResolutionPolicy,
  };
}

function findingSubject(finding: { name: string; version: string }): string {
  return `${finding.name}@${finding.version}`;
}

export function summarizeNpmSecurityReport(
  report: NpmSecurityReport,
  options: { maxDetails?: number } = {}
): NpmSecurityConsoleSummary {
  const blockingAdvisories = report.advisories.filter((finding) => finding.severity === 'error');
  const warningAdvisories = report.advisories.filter((finding) => finding.severity === 'warning');
  const blockingStatic = report.staticFindings.filter(
    (finding) => finding.severity === 'error' && !finding.allowed
  );
  const warningStatic = report.staticFindings.filter(
    (finding) => finding.severity === 'warning' && !finding.allowed
  );
  const approvedStatic = report.staticFindings.filter((finding) => finding.allowed);
  const lifecycleScripts = report.staticFindings.filter(
    (finding) => finding.type === 'lifecycle-script'
  );
  const detailCandidates: NpmSecurityConsoleDetail[] = [
    ...report.errors.map((error) => ({
      level: 'error' as const,
      message: `Scanner error: ${error}`,
    })),
    ...blockingAdvisories.map((finding) => ({
      level: 'error' as const,
      message: `${finding.type === 'malware' ? 'Malware' : 'Advisory'} [${findingSubject(finding)}] ${finding.id}${finding.summary ? `: ${finding.summary}` : ''}`,
    })),
    ...blockingStatic.map((finding) => ({
      level: 'error' as const,
      message: `Blocked static finding [${findingSubject(finding)}] ${finding.field}: ${finding.message}`,
    })),
  ];
  const maxDetails = Math.max(0, Math.floor(options.maxDetails ?? 20));

  return {
    approved: approvedStatic.length,
    blocking: report.errors.length + blockingAdvisories.length + blockingStatic.length,
    blockingAdvisories: blockingAdvisories.length,
    blockingStatic: blockingStatic.length,
    details: detailCandidates.slice(0, maxDetails),
    lifecycleScripts: lifecycleScripts.length,
    omitted: Math.max(0, detailCandidates.length - maxDetails),
    scannerErrors: report.errors.length,
    warningAdvisories: warningAdvisories.length,
    warningStatic: warningStatic.length,
    warnings: warningAdvisories.length + warningStatic.length,
  };
}

export interface ScanNpmBundleSecurityOptions {
  advisoryClient?: NpmAdvisoryClient;
  bundleDir: string;
  generatedAt?: string;
  inspectionCache?: TarballInspectionCache;
  manifest: BundleManifest;
  policy?: Partial<NpmSecurityPolicy>;
}

export async function scanNpmBundleSecurity(
  options: ScanNpmBundleSecurityOptions
): Promise<NpmSecurityReport> {
  const policy = normalizePolicy(options.policy);
  const errors: string[] = [];
  const staticFindings: NpmStaticSecurityFinding[] = [];
  const packagesWithHashes = options.manifest.packages.filter(
    (pkg): pkg is ResolvedPackage & { sha256: string } => typeof pkg.sha256 === 'string'
  );
  if (
    options.manifest.schemaVersion !== 2 ||
    packagesWithHashes.length !== options.manifest.packages.length
  ) {
    errors.push(
      'npm security scanning requires a schemaVersion 2 manifest with SHA-256 for every package'
    );
  }

  for (const pkg of packagesWithHashes) {
    const tarballPath = path.join(options.bundleDir, pkg.file);
    try {
      const inspection = await inspectPackageTarball(tarballPath, pkg, options.inspectionCache);
      staticFindings.push(...scanManifest(pkg, inspection.manifest, policy));
    } catch (error) {
      errors.push(`${pkg.name}@${pkg.version}: ${(error as Error).message}`);
    }
  }

  const advisories: NpmSecurityAdvisoryFinding[] = [];
  try {
    const advisoryResults = await (options.advisoryClient ?? new OsvNpmAdvisoryClient()).query(
      options.manifest.packages.map(({ name, version }) => ({ name, version }))
    );
    advisories.push(...osvFindings(options.manifest.packages, advisoryResults));
  } catch (error) {
    errors.push(`OSV: ${(error as Error).message}`);
  }

  const blockedStatic = staticFindings.some(
    (finding) => finding.severity === 'error' && !finding.allowed
  );
  const blockedAdvisory = advisories.some((finding) => finding.severity === 'error');
  return {
    advisories,
    errors,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    manifestSha256: semanticDigest(options.manifest),
    ok: errors.length === 0 && !blockedStatic && !blockedAdvisory,
    packageCount: options.manifest.packages.length,
    policy,
    provider: { name: 'OSV', url: 'https://api.osv.dev/v1/querybatch' },
    schemaVersion: 1,
    staticFindings,
  };
}

export async function writeNpmSecurityReport(
  bundleDir: string,
  report: NpmSecurityReport,
  options: { failed?: boolean } = {}
): Promise<void> {
  await fs.writeJsonAtomic(
    path.join(bundleDir, options.failed ? 'security-report.failed.json' : 'security-report.json'),
    report,
    { spaces: 2 }
  );
}

export async function assertNpmSecurityGate(
  bundleDir: string,
  manifest: BundleManifest,
  options: { now?: Date } = {}
): Promise<NpmSecurityReport> {
  if (manifest.schemaVersion !== 2 || manifest.packages.some((pkg) => !pkg.sha256)) {
    throw new Error('Refusing npm publication: legacy bundle has no complete SHA-256 manifest');
  }

  const reportPath = path.join(bundleDir, 'security-report.json');
  let report: NpmSecurityReport;
  try {
    report = await fs.readJson<NpmSecurityReport>(reportPath);
  } catch (error) {
    throw new Error(
      `Refusing npm publication: security-report.json is missing or unreadable: ${(error as Error).message}`
    );
  }
  const reportSchema = report as unknown as { schemaVersion?: number };
  if (reportSchema.schemaVersion !== 1 || !report.ok) {
    throw new Error('Refusing npm publication: security report did not pass');
  }
  if (report.manifestSha256 !== semanticDigest(manifest)) {
    throw new Error('Refusing npm publication: security report does not match seed-manifest.json');
  }
  const reportTime = Date.parse(report.generatedAt);
  const ageMs = (options.now ?? new Date()).getTime() - reportTime;
  if (
    !Number.isFinite(reportTime) ||
    ageMs < 0 ||
    ageMs > report.policy.maxReportAgeHours * 60 * 60 * 1000
  ) {
    throw new Error(
      `Refusing npm publication: security report is older than ${String(report.policy.maxReportAgeHours)} hours`
    );
  }
  return report;
}
