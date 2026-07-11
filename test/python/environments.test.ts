import { describe, expect, it } from 'vitest';
import type { PythonTargetArch, PythonTargetOs } from '../../src/core/python/environments.js';
import {
  environmentSatisfiesRequiresPython,
  resolveTargetEnvironment,
  wheelPriorityInEnvironment,
} from '../../src/core/python/environments.js';
import { parseWheelFilename } from '../../src/core/python/wheels.js';

const linux311 = resolveTargetEnvironment({
  arch: 'x86_64',
  manylinux: 'manylinux_2_17',
  name: 'prod-linux',
  os: 'linux',
  pythonVersion: '3.11.0',
});

function priorityOf(filename: string, environment = linux311): number | undefined {
  const wheel = parseWheelFilename(filename);
  expect(wheel).toBeDefined();
  return wheel && wheelPriorityInEnvironment(wheel, environment);
}

describe('resolveTargetEnvironment', () => {
  it('builds a marker environment from the config', () => {
    expect(linux311.markerEnvironment).toMatchObject({
      implementation_name: 'cpython',
      os_name: 'posix',
      platform_machine: 'x86_64',
      platform_system: 'Linux',
      python_full_version: '3.11.0',
      python_version: '3.11',
      sys_platform: 'linux',
    });

    const windows = resolveTargetEnvironment({
      arch: 'x86_64',
      name: 'win',
      os: 'windows',
      pythonVersion: '3.12.1',
    });
    expect(windows.markerEnvironment).toMatchObject({
      os_name: 'nt',
      platform_machine: 'AMD64',
      platform_system: 'Windows',
      python_full_version: '3.12.1',
      sys_platform: 'win32',
    });
  });

  it('resolves every supported os/arch combination', () => {
    const matrix: { arch: PythonTargetArch; os: PythonTargetOs }[] = [
      { arch: 'aarch64', os: 'linux' },
      { arch: 'ppc64le', os: 'linux' },
      { arch: 's390x', os: 'linux' },
      { arch: 'i686', os: 'linux' },
      { arch: 'i686', os: 'windows' },
      { arch: 'arm64', os: 'windows' },
      { arch: 'x86_64', os: 'macos' },
    ];
    for (const { arch, os } of matrix) {
      const environment = resolveTargetEnvironment({
        arch,
        ...(os === 'linux' ? { manylinux: 'manylinux_2_17' } : {}),
        name: 'm',
        os,
        pythonVersion: '3.12.0',
      });
      expect(environment.platformTags.length).toBeGreaterThan(0);
    }
  });

  it('accepts explicit platform tags as an escape hatch', () => {
    const custom = resolveTargetEnvironment({
      arch: 'x86_64',
      name: 'custom',
      os: 'linux',
      platformTags: ['manylinux_2_31_x86_64'],
      pythonVersion: '3.10.0',
    });
    expect(custom.platformTags).toEqual(['manylinux_2_31_x86_64']);
  });

  it('rejects invalid configurations', () => {
    expect(() =>
      resolveTargetEnvironment({ arch: 'x86_64', name: 'e', os: 'linux', pythonVersion: '3' })
    ).toThrow(/pythonVersion/);
    expect(() =>
      resolveTargetEnvironment({
        arch: 'x86_64',
        manylinux: 'manylinux_2_17',
        name: 'e',
        os: 'linux',
        pythonVersion: '2.7.0',
      })
    ).toThrow(/CPython 3.x/);
    expect(() =>
      resolveTargetEnvironment({
        arch: 'arm64',
        manylinux: 'manylinux_2_17',
        name: 'e',
        os: 'linux',
        pythonVersion: '3.11.0',
      })
    ).toThrow(/does not support arch/);
    expect(() =>
      resolveTargetEnvironment({
        arch: 'x86_64',
        manylinux: 'manylinux_3_1',
        name: 'e',
        os: 'linux',
        pythonVersion: '3.11.0',
      })
    ).toThrow(/manylinux/);
    expect(() =>
      resolveTargetEnvironment({
        arch: 'arm64',
        macosVersion: '10.15',
        name: 'e',
        os: 'macos',
        pythonVersion: '3.11.0',
      })
    ).toThrow(/only x86_64/);
    expect(() =>
      resolveTargetEnvironment({
        arch: 'x86_64',
        name: 'e',
        os: 'linux',
        platformTags: [],
        pythonVersion: '3.11.0',
      })
    ).toThrow(/platformTags/);
    expect(() =>
      resolveTargetEnvironment({
        arch: 'x86_64',
        manylinux: 'manylinux_2_17',
        name: ' ',
        os: 'linux',
        pythonVersion: '3.11.0',
      })
    ).toThrow(/name/);
  });
});

describe('wheelPriorityInEnvironment', () => {
  it('matches interpreter, abi3, pure, and legacy-alias wheels in preference order', () => {
    const exact = priorityOf('pydantic_core-2.16.3-cp311-cp311-manylinux_2_17_x86_64.whl');
    const alias = priorityOf(
      'pydantic_core-2.16.3-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'
    );
    const abi3 = priorityOf('cryptography-42.0.5-cp39-abi3-manylinux_2_17_x86_64.whl');
    const plainLinux = priorityOf('foo-1.0-cp311-cp311-linux_x86_64.whl');
    const pure = priorityOf('six-1.16.0-py2.py3-none-any.whl');

    expect(exact).toBe(0);
    expect(alias).toBe(0);
    expect(abi3).toBeDefined();
    expect(plainLinux).toBeDefined();
    expect(pure).toBeDefined();
    expect(exact!).toBeLessThan(abi3!);
    expect(abi3!).toBeLessThan(pure!);
    expect(exact!).toBeLessThan(plainLinux!);
  });

  it('rejects incompatible wheels', () => {
    expect(priorityOf('numpy-2.2.6-cp310-cp310-manylinux_2_17_x86_64.whl')).toBeUndefined();
    expect(priorityOf('numpy-2.2.6-cp311-cp311-win_amd64.whl')).toBeUndefined();
    expect(priorityOf('numpy-2.2.6-cp311-cp311-manylinux_2_28_x86_64.whl')).toBeUndefined();
    expect(priorityOf('foo-1.0-cp311-cp311-musllinux_1_2_x86_64.whl')).toBeUndefined();
    expect(priorityOf('foo-1.0-cp311-cp311-manylinux_2_17_aarch64.whl')).toBeUndefined();
  });

  it('supports musl, windows, and macOS targets', () => {
    const musl = resolveTargetEnvironment({
      arch: 'x86_64',
      musllinux: 'musllinux_1_2',
      name: 'alpine',
      os: 'linux',
      pythonVersion: '3.11.0',
    });
    expect(priorityOf('foo-1.0-cp311-cp311-musllinux_1_1_x86_64.whl', musl)).toBeDefined();
    expect(priorityOf('foo-1.0-cp311-cp311-manylinux_2_17_x86_64.whl', musl)).toBeUndefined();

    const windows = resolveTargetEnvironment({
      arch: 'x86_64',
      name: 'win',
      os: 'windows',
      pythonVersion: '3.12.0',
    });
    expect(priorityOf('numpy-2.2.6-cp312-cp312-win_amd64.whl', windows)).toBeDefined();

    const mac = resolveTargetEnvironment({
      arch: 'arm64',
      macosVersion: '14',
      name: 'mac',
      os: 'macos',
      pythonVersion: '3.12.0',
    });
    expect(priorityOf('torch-2.3.1-cp312-none-macosx_11_0_arm64.whl', mac)).toBeDefined();
    expect(priorityOf('foo-1.0-cp312-cp312-macosx_12_0_universal2.whl', mac)).toBeDefined();
    expect(priorityOf('foo-1.0-cp312-cp312-macosx_10_15_x86_64.whl', mac)).toBeUndefined();
  });
});

describe('environmentSatisfiesRequiresPython', () => {
  it('checks the environment python version against requires-python', () => {
    expect(environmentSatisfiesRequiresPython(linux311, '>=3.9')).toBe(true);
    expect(environmentSatisfiesRequiresPython(linux311, '>=3.12')).toBe(false);
    expect(environmentSatisfiesRequiresPython(linux311, '>=3.6, <4')).toBe(true);
    expect(environmentSatisfiesRequiresPython(linux311, '')).toBe(true);
  });

  it('is lenient when requires-python cannot be parsed', () => {
    expect(environmentSatisfiesRequiresPython(linux311, 'garbage !!')).toBe(true);
  });
});
