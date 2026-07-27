export type BuiltInPlatformFamilyId = 'linux-glibc-x86_64' | 'windows-x86_64';

export type PlatformArchitecture = 'aarch64' | 'arm64' | 'i686' | 'ppc64le' | 's390x' | 'x86_64';

export type PlatformFamilyStatus = 'experimental' | 'supported';
export type PlatformOsFamily = 'linux' | 'macos' | 'windows';
export type PlatformLibcFamily = 'glibc' | 'musl';

export interface PlatformFamily {
  architecture: PlatformArchitecture;
  definitionVersion: number;
  id: string;
  libc?: PlatformLibcFamily;
  os: PlatformOsFamily;
  status: PlatformFamilyStatus;
  wheelPlatformFamilies: string[];
}

const builtInPlatformFamilyIds = new Set<string>(['linux-glibc-x86_64', 'windows-x86_64']);

export function isBuiltInPlatformFamilyId(value: string): value is BuiltInPlatformFamilyId {
  return builtInPlatformFamilyIds.has(value);
}
