import type { ResolvedTargetEnvironment } from './environments.js';
import type { PythonIndexFile } from './index-client.js';
import type { PythonCoreMetadata } from './metadata.js';

export interface PythonResolutionReason {
  raw: string;
  requiredBy: string;
  sourcePath: string;
  type: 'dependency' | 'locked' | 'requirement' | 'target';
}

export interface ResolvedPythonArtifact {
  approximate: boolean;
  environment: string;
  file: PythonIndexFile;
  metadata?: PythonCoreMetadata;
  name: string;
  reasons: PythonResolutionReason[];
  version: string;
}

export interface PythonResolutionError {
  environment: string;
  name?: string;
  raw?: string;
  reason: string;
  requiredBy?: string;
}

export interface PythonResolutionResult {
  artifacts: ResolvedPythonArtifact[];
  approximate: boolean;
  environments: ResolvedTargetEnvironment[];
  errors: PythonResolutionError[];
}
