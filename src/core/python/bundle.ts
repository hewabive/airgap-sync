import path from 'node:path';
import * as fs from '../fs.js';
import type { PythonTargetEnvironmentConfig } from './environments.js';
import type { PythonCoreMetadata } from './metadata.js';
import type { PythonPublishReport } from './publisher.js';

interface PythonSeedReason {
  environments: string[];
  raw: string;
  requiredBy: string;
  sourcePath: string;
  type: 'target';
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

export async function readPythonSeedManifest(bundleDir: string): Promise<PythonSeedManifest> {
  return fs.readJson<PythonSeedManifest>(path.join(bundleDir, 'python-seed-manifest.json'));
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
