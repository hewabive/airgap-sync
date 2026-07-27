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

const platformFamilies: readonly PlatformFamily[] = [
  {
    architecture: 'x86_64',
    definitionVersion: 1,
    id: 'windows-x86_64',
    os: 'windows',
    status: 'supported',
    wheelPlatformFamilies: ['win_amd64'],
  },
  {
    architecture: 'x86_64',
    definitionVersion: 1,
    id: 'linux-glibc-x86_64',
    libc: 'glibc',
    os: 'linux',
    status: 'supported',
    wheelPlatformFamilies: ['manylinux_x86_64'],
  },
];

export function listBuiltInPlatformFamilies(): PlatformFamily[] {
  return platformFamilies.map((family) => ({
    ...family,
    wheelPlatformFamilies: [...family.wheelPlatformFamilies],
  }));
}

export function getBuiltInPlatformFamily(id: string): PlatformFamily | undefined {
  const family = platformFamilies.find((candidate) => candidate.id === id);
  return family
    ? {
        ...family,
        wheelPlatformFamilies: [...family.wheelPlatformFamilies],
      }
    : undefined;
}

export function isBuiltInPlatformFamilyId(value: string): value is BuiltInPlatformFamilyId {
  return builtInPlatformFamilyIds.has(value);
}
