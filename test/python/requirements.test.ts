import { describe, expect, it } from 'vitest';
import type { ParsedRequirement } from '../../src/core/python/requirements.js';
import { parseRequirement } from '../../src/core/python/requirements.js';

describe('parseRequirement', () => {
  it('parses a bare package name', () => {
    expect(parseRequirement('requests')).toEqual({
      ok: true,
      requirement: {
        extras: [],
        name: 'requests',
        normalizedName: 'requests',
        raw: 'requests',
        specifier: '',
      },
    });
  });

  it('parses pins, ranges, extras, and markers', () => {
    const pinned: ParsedRequirement = {
      extras: [],
      name: 'numpy',
      normalizedName: 'numpy',
      raw: 'numpy==1.26.4',
      specifier: '==1.26.4',
    };
    expect(parseRequirement('numpy==1.26.4')).toEqual({ ok: true, requirement: pinned });

    expect(
      parseRequirement('Requests[socks, Security] >= 2.31, < 3 ; python_version >= "3.8"')
    ).toEqual({
      ok: true,
      requirement: {
        extras: ['socks', 'security'],
        marker: 'python_version >= "3.8"',
        name: 'Requests',
        normalizedName: 'requests',
        raw: 'Requests[socks, Security] >= 2.31, < 3 ; python_version >= "3.8"',
        specifier: '>= 2.31, < 3',
      },
    });
  });

  it('accepts parenthesized specifiers', () => {
    const result = parseRequirement('zope.interface (>=4.0.0)');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requirement.name).toBe('zope.interface');
      expect(result.requirement.specifier).toBe('>=4.0.0');
    }
  });

  it('keeps semicolons inside marker strings out of the split', () => {
    const result = parseRequirement('foo>=1.0 ; sys_platform == "a;b" or os_name == "posix"');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requirement.specifier).toBe('>=1.0');
      expect(result.requirement.marker).toBe('sys_platform == "a;b" or os_name == "posix"');
    }
  });

  it('parses URL requirements', () => {
    const result = parseRequirement(
      'pip @ https://github.com/pypa/pip/archive/22.0.2.zip ; python_version >= "3.7"'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requirement.url).toBe('https://github.com/pypa/pip/archive/22.0.2.zip');
      expect(result.requirement.specifier).toBe('');
      expect(result.requirement.marker).toBe('python_version >= "3.7"');
    }
  });

  it('rejects invalid input with reasons', () => {
    expect(parseRequirement('')).toMatchObject({ ok: false, reason: 'Requirement is empty' });
    expect(parseRequirement('==1.0')).toMatchObject({ ok: false });
    expect(parseRequirement('foo==banana')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Invalid version specifier') as string,
    });
    expect(parseRequirement('foo[bar')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('closing bracket') as string,
    });
    expect(parseRequirement('foo[ba r]')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('invalid extra') as string,
    });
    expect(parseRequirement('foo >=1.0 ; junk_var == "1"')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unknown marker variable') as string,
    });
    expect(parseRequirement('foo @ ')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('missing the URL') as string,
    });
  });

  it('normalizes names but preserves the written form', () => {
    const result = parseRequirement('Typing_Extensions>=4');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requirement.name).toBe('Typing_Extensions');
      expect(result.requirement.normalizedName).toBe('typing-extensions');
    }
  });
});
