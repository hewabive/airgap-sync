import { describe, expect, it } from 'vitest';
import {
  parseLinuxWheelCompatibility,
  parsePythonResolutionMode,
  parsePythonTargetArch,
  parsePythonTargetOs,
  parsePythonVersion,
  supportedPythonTargetArches,
  validatePythonIndexUrl,
} from '../src/menu/python-settings.js';

describe('Python menu settings', () => {
  it('parses resolution mode, operating system, and full Python versions', () => {
    expect(parsePythonResolutionMode('approximate')).toBe('approximate');
    expect(parsePythonTargetOs(' Windows ')).toBe('windows');
    expect(parsePythonVersion(' 3.12.13 ')).toBe('3.12.13');

    expect(() => parsePythonResolutionMode('backtracking')).toThrow(/locked-only/);
    expect(() => parsePythonTargetOs('freebsd')).toThrow(/linux, windows, or macos/);
    expect(() => parsePythonVersion('3.12')).toThrow(/MAJOR\.MINOR\.PATCH/);
  });

  it('limits architectures to those supported by each target OS', () => {
    expect(supportedPythonTargetArches('linux')).toContain('aarch64');
    expect(supportedPythonTargetArches('macos')).toEqual(['x86_64', 'arm64']);
    expect(parsePythonTargetArch(' ARM64 ', 'windows')).toBe('arm64');
    expect(() => parsePythonTargetArch('aarch64', 'windows')).toThrow(/architecture/);
  });

  it('parses Linux compatibility tags', () => {
    expect(parseLinuxWheelCompatibility('manylinux_2_17')).toEqual({
      manylinux: 'manylinux_2_17',
    });
    expect(parseLinuxWheelCompatibility('musllinux_1_2')).toEqual({
      musllinux: 'musllinux_1_2',
    });
    expect(parseLinuxWheelCompatibility('manylinux2014')).toEqual({
      manylinux: 'manylinux2014',
    });
    expect(() => parseLinuxWheelCompatibility('linux_x86_64')).toThrow(/manylinux or musllinux/);
  });

  it('accepts only HTTP Python indexes and normalizes the URL', () => {
    expect(validatePythonIndexUrl('https://pypi.org/simple')).toBe('https://pypi.org/simple');
    expect(() => validatePythonIndexUrl('file:///tmp/simple')).toThrow(/HTTP or HTTPS/);
  });
});
