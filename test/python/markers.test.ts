import { describe, expect, it } from 'vitest';
import type { MarkerEnvironment } from '../../src/core/python/markers.js';
import { evaluateMarker, parseMarker, tryEvaluateMarker } from '../../src/core/python/markers.js';

const linux311: MarkerEnvironment = {
  implementation_name: 'cpython',
  implementation_version: '3.11.0',
  os_name: 'posix',
  platform_machine: 'x86_64',
  platform_python_implementation: 'CPython',
  platform_release: '6.8.0',
  platform_system: 'Linux',
  platform_version: '#1 SMP',
  python_full_version: '3.11.0',
  python_version: '3.11',
  sys_platform: 'linux',
};

describe('evaluateMarker', () => {
  it('compares python versions with PEP 440 semantics', () => {
    expect(evaluateMarker('python_version >= "3.8"', linux311)).toBe(true);
    expect(evaluateMarker('python_version < "3.11"', linux311)).toBe(false);
    expect(evaluateMarker('python_full_version < "3.11.3"', linux311)).toBe(true);
    // Zero padding: "3.11" == "3.11.0".
    expect(evaluateMarker('python_full_version == "3.11"', linux311)).toBe(true);
    expect(evaluateMarker('python_version ~= "3.10"', linux311)).toBe(true);
    expect(evaluateMarker('python_version in "3.11"', linux311)).toBe(false);
  });

  it('compares non-version operands as strings', () => {
    expect(evaluateMarker('sys_platform == "linux"', linux311)).toBe(true);
    expect(evaluateMarker('platform_system != "Windows"', linux311)).toBe(true);
    expect(evaluateMarker('platform_machine == "x86_64"', linux311)).toBe(true);
    expect(evaluateMarker('sys_platform > "darwin"', linux311)).toBe(false);
    expect(evaluateMarker('sys_platform >= "linux"', linux311)).toBe(true);
  });

  it('supports in and not in as substring tests', () => {
    expect(evaluateMarker('"linu" in sys_platform', linux311)).toBe(true);
    expect(evaluateMarker('"win" not in sys_platform', linux311)).toBe(true);
    expect(evaluateMarker('sys_platform in "linux darwin"', linux311)).toBe(true);
  });

  it('applies and/or precedence and parentheses', () => {
    expect(
      evaluateMarker('python_version < "3.0" and sys_platform == "linux" or os_name == "posix"', {
        ...linux311,
      })
    ).toBe(true);
    expect(
      evaluateMarker('python_version < "3.0" and (sys_platform == "linux" or os_name == "posix")', {
        ...linux311,
      })
    ).toBe(false);
  });

  it('evaluates extra against the active extra and defaults to empty', () => {
    expect(() => evaluateMarker('extra == "socks"', linux311)).toThrow(/has no value/);
    expect(evaluateMarker('extra == "socks"', { ...linux311, extra: ['security', 'socks'] })).toBe(
      true
    );
    expect(evaluateMarker('extra != "socks"', { ...linux311, extra: [] })).toBe(true);
  });

  it('evaluates lock-file extras and dependency groups as sets', () => {
    const lockEnvironment = {
      ...linux311,
      dependency_groups: ['test'],
      extras: ['speed-ups'],
    };
    expect(evaluateMarker('"speed_ups" in extras', lockEnvironment)).toBe(true);
    expect(evaluateMarker('"docs" not in dependency_groups', lockEnvironment)).toBe(true);
    expect(evaluateMarker('extras == "speed-ups"', lockEnvironment)).toBe(false);
  });

  it('resolves deprecated dotted variable aliases', () => {
    expect(evaluateMarker('sys.platform == "linux"', linux311)).toBe(true);
    expect(evaluateMarker('os.name == "posix"', linux311)).toBe(true);
  });
});

describe('parseMarker', () => {
  it('rejects unknown variables, bad operators, and truncated expressions', () => {
    expect(() => parseMarker('unknown_var == "x"')).toThrow(/unknown marker variable/);
    expect(() => parseMarker('python_version >= ')).toThrow(/unexpected end/);
    expect(() => parseMarker('python_version not "3"')).toThrow(/must be followed by "in"/);
    expect(() => parseMarker('(python_version >= "3"')).toThrow(/closing parenthesis/);
    expect(() => parseMarker('python_version >= "3" garbage')).toThrow(/unexpected token/);
    expect(() => parseMarker('')).toThrow(/empty/);
    expect(() => parseMarker('python_version >= "3')).toThrow(/unterminated string/);
  });
});

describe('tryEvaluateMarker', () => {
  it('returns evaluation failures instead of throwing', () => {
    expect(tryEvaluateMarker('sys_platform == "linux"', linux311)).toEqual({
      ok: true,
      value: true,
    });
    const failed = tryEvaluateMarker('nope == "1"', linux311);
    expect(failed.ok).toBe(false);
  });
});
