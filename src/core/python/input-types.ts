import type { ParsedRequirement } from './requirements.js';
import type { PythonResolutionMode } from './resolution-policy.js';

export interface PythonRequirementHash {
  algorithm: string;
  digest: string;
}

export interface PythonRequirementInput {
  constraint: boolean;
  hashes: PythonRequirementHash[];
  line: number;
  pythonResolutionMode?: PythonResolutionMode;
  requiredBy: string;
  requirement: ParsedRequirement;
  sourcePath: string;
}

export interface PythonRootWheelInput {
  line: number;
  pythonResolutionMode?: PythonResolutionMode;
  requiredBy: string;
  sha256: string;
  sourcePath: string;
  url: string;
}

export interface UnsupportedPythonInput {
  line?: number;
  raw: string;
  reason: string;
  requiredBy: string;
  sourcePath: string;
  type: string;
}

export interface PythonRequirementsInput {
  files: string[];
  requirements: PythonRequirementInput[];
  unsupported: UnsupportedPythonInput[];
}

export interface PythonLockedFile {
  filename: string;
  hashes: Record<string, string>;
  size?: number;
  url: string;
}

export interface PythonLockedDependency {
  extras?: string[];
  marker?: string;
  name: string;
  source?: string;
  version?: string;
}

export type PythonLockedSourceKind =
  | 'registry'
  | 'editable'
  | 'virtual'
  | 'directory'
  | 'vcs'
  | 'archive'
  | 'unknown';

export interface PythonLockedPackage {
  dependencies: PythonLockedDependency[];
  devDependencies: Record<string, PythonLockedDependency[]>;
  marker?: string;
  name: string;
  optionalDependencies: Record<string, PythonLockedDependency[]>;
  requiresPython?: string;
  source?: string;
  sourceKind: PythonLockedSourceKind;
  version?: string;
  wheels: PythonLockedFile[];
}

export interface PythonLockInput {
  createdBy?: string;
  defaultGroups: string[];
  dependencyGroups: string[];
  environments: string[];
  extras: string[];
  format: 'pylock' | 'uv';
  packages: PythonLockedPackage[];
  requiresPython?: string;
  sourcePath: string;
  version: string;
}

export interface PythonDiscoveredInputs {
  lockfiles: PythonLockInput[];
  lockfilePaths: string[];
  pyprojectWithoutLock: string[];
  requirements: PythonRequirementInput[];
  requirementPaths: string[];
  unsupported: UnsupportedPythonInput[];
}
