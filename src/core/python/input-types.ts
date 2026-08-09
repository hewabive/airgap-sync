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
