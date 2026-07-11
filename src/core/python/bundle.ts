import path from 'node:path';
import * as fs from '../fs.js';
import type { PythonTargetEnvironmentConfig } from './environments.js';
import type { UnsupportedPythonInput } from './input-types.js';
import type { PythonCoreMetadata } from './metadata.js';
import type { PythonResolutionError, PythonResolutionReason } from './resolution-types.js';
import type { PythonPublishReport } from './publisher.js';

export interface PythonSeedReason extends PythonResolutionReason {
  environments: string[];
}

export interface PythonSeedFile {
  coreMetadata: PythonCoreMetadata;
  environments: string[];
  file: string;
  filename: string;
  kind: 'wheel';
  sha256: string;
  sourceHashes: Record<string, string>;
  url: string;
}

export interface PythonSeedPackage {
  files: PythonSeedFile[];
  name: string;
  requiresPython?: string;
  resolvedFrom: PythonSeedReason[];
  version: string;
}

export interface PythonSeedManifest {
  schemaVersion: 1;
  createdAt: string;
  packages: PythonSeedPackage[];
  roots: string[];
  sourceIndex: string;
  targetEnvironments: PythonTargetEnvironmentConfig[];
}

export interface PythonFetchAction {
  environments: string[];
  error?: string;
  file: string;
  package: string;
  status: 'planned' | 'downloaded' | 'skipped' | 'error';
}

export interface PythonFetchError {
  environment?: string;
  file?: string;
  name?: string;
  reason: string;
  stage: 'download' | 'metadata' | 'resolution';
}

export interface PythonEnvironmentSummary {
  environment: string;
  files: number;
  packages: number;
  size: number;
}

export interface PythonFetchReport {
  actions: PythonFetchAction[];
  approximate: boolean;
  downloaded: number;
  dryRun: boolean;
  enabled: boolean;
  environmentTotals: PythonEnvironmentSummary[];
  errors: PythonFetchError[];
  generatedAt: string;
  planned: number;
  resolvedFiles: number;
  resolvedPackages: number;
  skipped: number;
  sourceIndex: string;
  unsupported: UnsupportedPythonInput[];
}

export function resolutionErrors(errors: PythonResolutionError[]): PythonFetchError[] {
  return errors.map((error) => ({
    environment: error.environment,
    ...(error.name ? { name: error.name } : {}),
    reason: error.reason,
    stage: 'resolution',
  }));
}

export async function readPythonSeedManifest(bundleDir: string): Promise<PythonSeedManifest> {
  return fs.readJson<PythonSeedManifest>(path.join(bundleDir, 'python-seed-manifest.json'));
}

export async function writePythonSeedManifest(
  bundleDir: string,
  manifest: PythonSeedManifest
): Promise<void> {
  await fs.writeJsonAtomic(path.join(bundleDir, 'python-seed-manifest.json'), manifest, {
    spaces: 2,
  });
}

export async function writePythonFetchReport(
  bundleDir: string,
  report: PythonFetchReport
): Promise<void> {
  await fs.writeJson(path.join(bundleDir, 'python-fetch-report.json'), report, { spaces: 2 });
}

export async function writePythonPublishReport(
  bundleDir: string,
  report: PythonPublishReport
): Promise<void> {
  await fs.writeJson(
    path.join(
      bundleDir,
      report.dryRun ? 'python-publish-dry-run-report.json' : 'python-publish-report.json'
    ),
    report,
    { spaces: 2 }
  );
}
