import type { InlinePlatformCoveragePolicy, PlatformCoveragePolicy } from './coverage-policy.js';

export type PythonRuntimePolicy =
  | { policy: 'auto' }
  | { policy: 'constrained'; version: string }
  | { policy: 'selected'; versions: string[] };

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
    type: 'pypi';
  };
  updatePolicy: 'manual';
}
