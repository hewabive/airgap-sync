import type { PythonTargetArch, PythonTargetOs } from '../core/python/environments.js';
import type { PythonResolutionMode } from '../core/workspace.js';

export function parsePythonResolutionMode(value: string): PythonResolutionMode {
  if (value === 'locked-only' || value === 'approximate') {
    return value;
  }

  throw new Error(
    `Expected Python resolution mode to be "locked-only" or "approximate"; got: ${value}`
  );
}

export function parsePythonTargetOs(value: string): PythonTargetOs {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'linux' || normalized === 'windows' || normalized === 'macos') {
    return normalized;
  }

  throw new Error(`Expected Python target OS to be linux, windows, or macos; got: ${value}`);
}

export function supportedPythonTargetArches(os: PythonTargetOs): PythonTargetArch[] {
  switch (os) {
    case 'linux':
      return ['x86_64', 'aarch64', 'i686', 'ppc64le', 's390x'];
    case 'macos':
      return ['x86_64', 'arm64'];
    case 'windows':
      return ['x86_64', 'i686', 'arm64'];
  }
}

export function parsePythonTargetArch(value: string, os: PythonTargetOs): PythonTargetArch {
  const normalized = value.trim().toLowerCase();
  const arches = supportedPythonTargetArches(os);
  if (arches.includes(normalized as PythonTargetArch)) {
    return normalized as PythonTargetArch;
  }

  throw new Error(`Expected ${os} architecture to be one of ${arches.join(', ')}; got: ${value}`);
}

export function parsePythonVersion(value: string): string {
  const normalized = value.trim();
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`Expected a full Python MAJOR.MINOR.PATCH version; got: ${value}`);
  }

  return normalized;
}

export function parseLinuxWheelCompatibility(value: string): {
  manylinux?: string;
  musllinux?: string;
} {
  const normalized = value.trim();
  if (/^manylinux(?:\d{4}|1|_\d+_\d+)$/.test(normalized)) {
    return { manylinux: normalized };
  }
  if (/^musllinux_\d+_\d+$/.test(normalized)) {
    return { musllinux: normalized };
  }

  throw new Error(
    `Expected a manylinux or musllinux compatibility tag, for example manylinux_2_17; got: ${value}`
  );
}

export function validatePythonIndexUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Python source index must use HTTP or HTTPS');
  }

  return parsed.toString();
}
