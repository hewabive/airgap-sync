import sglang from '../../../support/python/sources/sglang.json' with { type: 'json' };
import { normalizePackageName } from './names.js';
import { normalizePythonResolutionPolicy, type PythonResolutionPolicy } from './source-policy.js';

const policies = new Map<string, PythonResolutionPolicy>([
  ['sglang', normalizePythonResolutionPolicy(sglang)!],
]);

/** Public-source defaults follow the application, not a particular release. */
export function maintainedPythonResolutionPolicy(
  application: string,
  sourceIndex: string
): PythonResolutionPolicy | undefined {
  const url = new URL(sourceIndex);
  // A custom primary index may intentionally describe a closed or curated source set.
  if (
    url.origin !== 'https://pypi.org' ||
    url.pathname.replace(/\/+$/u, '') !== '/simple' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return undefined;
  const policy = policies.get(normalizePackageName(application));
  return policy ? structuredClone(policy) : undefined;
}
