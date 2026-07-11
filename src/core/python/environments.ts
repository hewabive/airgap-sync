import type { MarkerEnvironment } from './markers.js';
import { isValidSpecifierSet, versionSatisfies } from './pep440.js';
import type { WheelFilename } from './wheels.js';
import { expandWheelTags } from './wheels.js';

export type PythonTargetOs = 'linux' | 'windows' | 'macos';

export type PythonTargetArch = 'x86_64' | 'aarch64' | 'i686' | 'ppc64le' | 's390x' | 'arm64';

export interface PythonTargetEnvironmentConfig {
  arch: PythonTargetArch;
  macosVersion?: string;
  manylinux?: string;
  markerOverrides?: {
    platformRelease?: string;
    platformVersion?: string;
  };
  musllinux?: string;
  name: string;
  os: PythonTargetOs;
  platformTags?: string[];
  pythonVersion: string;
}

export interface ResolvedTargetEnvironment {
  config: PythonTargetEnvironmentConfig;
  markerEnvironment: MarkerEnvironment;
  name: string;
  platformTags: string[];
  pythonFullVersion: string;
  pythonMajor: number;
  pythonMinor: number;
  tagPriority: Map<string, number>;
}

const LINUX_ARCHES = new Set<PythonTargetArch>(['x86_64', 'aarch64', 'i686', 'ppc64le', 's390x']);
const WINDOWS_ARCHES = new Set<PythonTargetArch>(['x86_64', 'i686', 'arm64']);
const MACOS_ARCHES = new Set<PythonTargetArch>(['x86_64', 'arm64']);

const MANYLINUX_LEGACY_ALIASES: Record<string, [number, number]> = {
  manylinux1: [2, 5],
  manylinux2010: [2, 12],
  manylinux2014: [2, 17],
};

const MANYLINUX2014_ARCHES = new Set<PythonTargetArch>([
  'x86_64',
  'i686',
  'aarch64',
  'ppc64le',
  's390x',
]);

const LEGACY_MANYLINUX_ARCHES = new Set<PythonTargetArch>(['x86_64', 'i686']);

function configError(config: PythonTargetEnvironmentConfig, message: string): Error {
  return new Error(`Invalid Python target environment "${config.name}": ${message}`);
}

function parsePythonVersion(config: PythonTargetEnvironmentConfig): {
  full: string;
  major: number;
  minor: number;
} {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(config.pythonVersion);
  if (!match) {
    throw configError(config, `pythonVersion "${config.pythonVersion}" is not MAJOR.MINOR.PATCH`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 3) {
    throw configError(config, 'only CPython 3.x target environments are supported');
  }

  return {
    full: config.pythonVersion,
    major,
    minor,
  };
}

function parseManylinux(config: PythonTargetEnvironmentConfig): [number, number] {
  const value = config.manylinux;
  if (!value) {
    throw configError(
      config,
      'Linux targets require manylinux, musllinux, or explicit platformTags'
    );
  }
  const alias = MANYLINUX_LEGACY_ALIASES[value];
  if (alias) {
    return alias;
  }

  const match = /^manylinux_(\d+)_(\d+)$/.exec(value);
  if (!match || Number(match[1]) !== 2) {
    throw configError(config, `manylinux "${value}" is not manylinux_2_<minor> or a known alias`);
  }

  return [2, Number(match[2])];
}

function linuxPlatformTags(config: PythonTargetEnvironmentConfig): string[] {
  const { arch } = config;
  const tags: string[] = [];

  if (config.manylinux !== undefined && config.musllinux !== undefined) {
    throw configError(config, 'manylinux and musllinux are mutually exclusive');
  }

  if (config.musllinux !== undefined) {
    const match = /^musllinux_(\d+)_(\d+)$/.exec(config.musllinux);
    if (!match) {
      throw configError(config, `musllinux "${config.musllinux}" is not musllinux_<major>_<minor>`);
    }
    const major = Number(match[1]);
    for (let minor = Number(match[2]); minor >= 0; minor -= 1) {
      tags.push(`musllinux_${String(major)}_${String(minor)}_${arch}`);
    }
    tags.push(`linux_${arch}`);
    return tags;
  }

  const [, maxMinor] = parseManylinux(config);
  const lowestMinor = LEGACY_MANYLINUX_ARCHES.has(arch) ? 5 : 17;

  for (let minor = maxMinor; minor >= lowestMinor; minor -= 1) {
    tags.push(`manylinux_2_${String(minor)}_${arch}`);
    if (minor === 17 && MANYLINUX2014_ARCHES.has(arch)) {
      tags.push(`manylinux2014_${arch}`);
    }
    if (minor === 12 && LEGACY_MANYLINUX_ARCHES.has(arch)) {
      tags.push(`manylinux2010_${arch}`);
    }
    if (minor === 5 && LEGACY_MANYLINUX_ARCHES.has(arch)) {
      tags.push(`manylinux1_${arch}`);
    }
  }

  tags.push(`linux_${arch}`);
  return tags;
}

function macosBinaryFormats(arch: PythonTargetArch, legacy: boolean): string[] {
  if (arch === 'arm64') {
    return ['arm64', 'universal2'];
  }

  return legacy
    ? ['x86_64', 'intel', 'fat64', 'fat32', 'universal2', 'universal']
    : ['x86_64', 'universal2', 'universal'];
}

function macosPlatformTags(config: PythonTargetEnvironmentConfig): string[] {
  const version = config.macosVersion ?? '12.0';
  const match = /^(\d+)(?:\.(\d+))?$/.exec(version);
  if (!match) {
    throw configError(config, `macosVersion "${version}" is not MAJOR[.MINOR]`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2] ?? '0');
  const tags: string[] = [];

  if (major >= 11) {
    for (let current = major; current >= 11; current -= 1) {
      for (const format of macosBinaryFormats(config.arch, false)) {
        tags.push(`macosx_${String(current)}_0_${format}`);
      }
    }
    if (config.arch === 'x86_64') {
      for (let current = 15; current >= 4; current -= 1) {
        for (const format of macosBinaryFormats(config.arch, true)) {
          tags.push(`macosx_10_${String(current)}_${format}`);
        }
      }
    }
    return tags;
  }

  if (major === 10) {
    if (config.arch !== 'x86_64') {
      throw configError(config, 'macOS 10.x target environments support only x86_64');
    }
    for (let current = minor; current >= 4; current -= 1) {
      for (const format of macosBinaryFormats(config.arch, true)) {
        tags.push(`macosx_10_${String(current)}_${format}`);
      }
    }
    return tags;
  }

  throw configError(config, `macosVersion "${version}" is older than macOS 10`);
}

function windowsPlatformTags(config: PythonTargetEnvironmentConfig): string[] {
  switch (config.arch) {
    case 'x86_64':
      return ['win_amd64'];
    case 'i686':
      return ['win32'];
    case 'arm64':
      return ['win_arm64'];
    default:
      throw configError(config, `Windows does not support arch "${config.arch}"`);
  }
}

function resolvePlatformTags(config: PythonTargetEnvironmentConfig): string[] {
  if (config.platformTags) {
    if (config.platformTags.length === 0) {
      throw configError(config, 'platformTags must not be empty when provided');
    }
    return config.platformTags;
  }

  switch (config.os) {
    case 'linux':
      if (!LINUX_ARCHES.has(config.arch)) {
        throw configError(config, `Linux does not support arch "${config.arch}"`);
      }
      return linuxPlatformTags(config);
    case 'macos':
      if (!MACOS_ARCHES.has(config.arch)) {
        throw configError(config, `macOS does not support arch "${config.arch}"`);
      }
      return macosPlatformTags(config);
    case 'windows':
      if (!WINDOWS_ARCHES.has(config.arch)) {
        throw configError(config, `Windows does not support arch "${config.arch}"`);
      }
      return windowsPlatformTags(config);
  }
}

function generateTagPriority(
  major: number,
  minor: number,
  platformTags: string[]
): Map<string, number> {
  const interpreter = `cp${String(major)}${String(minor)}`;
  const tags: string[] = [];

  for (const abi of [interpreter, 'abi3', 'none']) {
    for (const platformTag of platformTags) {
      tags.push(`${interpreter}-${abi}-${platformTag}`);
    }
  }

  for (let compatMinor = minor - 1; compatMinor >= 2; compatMinor -= 1) {
    for (const platformTag of platformTags) {
      tags.push(`cp${String(major)}${String(compatMinor)}-abi3-${platformTag}`);
    }
  }

  const pythonVersions = [`py${String(major)}${String(minor)}`, `py${String(major)}`];
  for (let compatMinor = minor - 1; compatMinor >= 0; compatMinor -= 1) {
    pythonVersions.push(`py${String(major)}${String(compatMinor)}`);
  }

  for (const pythonVersion of pythonVersions) {
    for (const platformTag of platformTags) {
      tags.push(`${pythonVersion}-none-${platformTag}`);
    }
  }

  tags.push(`${interpreter}-none-any`);
  for (const pythonVersion of pythonVersions) {
    tags.push(`${pythonVersion}-none-any`);
  }

  const priority = new Map<string, number>();
  tags.forEach((tag, index) => {
    if (!priority.has(tag)) {
      priority.set(tag, index);
    }
  });
  return priority;
}

function buildMarkerEnvironment(
  config: PythonTargetEnvironmentConfig,
  pythonVersion: string,
  pythonFullVersion: string
): MarkerEnvironment {
  const system = config.os === 'linux' ? 'Linux' : config.os === 'windows' ? 'Windows' : 'Darwin';
  const sysPlatform =
    config.os === 'linux' ? 'linux' : config.os === 'windows' ? 'win32' : 'darwin';

  let machine: string = config.arch;
  if (config.os === 'windows') {
    machine = config.arch === 'x86_64' ? 'AMD64' : config.arch === 'arm64' ? 'ARM64' : 'x86';
  }

  return {
    implementation_name: 'cpython',
    implementation_version: pythonFullVersion,
    os_name: config.os === 'windows' ? 'nt' : 'posix',
    platform_machine: machine,
    platform_python_implementation: 'CPython',
    ...(config.markerOverrides?.platformRelease !== undefined
      ? { platform_release: config.markerOverrides.platformRelease }
      : {}),
    platform_system: system,
    ...(config.markerOverrides?.platformVersion !== undefined
      ? { platform_version: config.markerOverrides.platformVersion }
      : {}),
    python_full_version: pythonFullVersion,
    python_version: pythonVersion,
    sys_platform: sysPlatform,
  };
}

export function resolveTargetEnvironment(
  config: PythonTargetEnvironmentConfig
): ResolvedTargetEnvironment {
  if (!config.name.trim()) {
    throw new Error('Python target environment name must not be empty');
  }

  const { full, major, minor } = parsePythonVersion(config);
  const platformTags = resolvePlatformTags(config);

  return {
    config,
    markerEnvironment: buildMarkerEnvironment(config, `${String(major)}.${String(minor)}`, full),
    name: config.name,
    platformTags,
    pythonFullVersion: full,
    pythonMajor: major,
    pythonMinor: minor,
    tagPriority: generateTagPriority(major, minor, platformTags),
  };
}

export function wheelPriorityInEnvironment(
  wheel: WheelFilename,
  environment: ResolvedTargetEnvironment
): number | undefined {
  let best: number | undefined;

  for (const tag of expandWheelTags(wheel)) {
    const priority = environment.tagPriority.get(tag);
    if (priority !== undefined && (best === undefined || priority < best)) {
      best = priority;
    }
  }

  return best;
}

export function environmentSatisfiesRequiresPython(
  environment: ResolvedTargetEnvironment,
  requiresPython: string
): boolean {
  const specifiers = requiresPython.trim();
  if (!specifiers) {
    return true;
  }

  if (!isValidSpecifierSet(specifiers)) {
    return true;
  }

  return versionSatisfies(environment.pythonFullVersion, specifiers);
}
