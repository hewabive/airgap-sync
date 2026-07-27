export type PythonResolutionMode = 'approximate' | 'locked-only';

export function isPythonResolutionMode(value: unknown): value is PythonResolutionMode {
  return value === 'approximate' || value === 'locked-only';
}
