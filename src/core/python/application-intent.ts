import type { PythonResolutionPolicy } from './source-policy.js';
import type { InlinePlatformCoveragePolicy, PlatformCoveragePolicy } from './coverage-policy.js';

export const initialPythonApplicationMinors = ['3.10', '3.11', '3.12', '3.13'];

export type PythonRuntimePolicy =
  | { policy: 'auto' }
  | { policy: 'constrained'; version: string }
  | { policy: 'selected'; versions: string[] };

export type PythonApplicationVersionSelector =
  | { constraint?: string; type: 'latest-compatible' }
  | { type: 'exact'; version: string };

export interface PythonApplicationVersionSelection {
  selectors: PythonApplicationVersionSelector[];
}

export interface PythonApplicationSelection {
  extras: string[];
  features: Record<string, string>;
  name: string;
  recipe?: string;
  version?: string;
}

export interface PythonApplicationIntent {
  application: PythonApplicationSelection;
  coverage: { inline: InlinePlatformCoveragePolicy } | { policyId: PlatformCoveragePolicy['id'] };
  python: PythonRuntimePolicy;
  source: {
    indexUrl?: string;
    resolution?: PythonResolutionPolicy;
    type: 'pypi';
  };
  updatePolicy: 'manual';
}
