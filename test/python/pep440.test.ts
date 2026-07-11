import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isPrereleaseVersion,
  isValidSpecifierSet,
  isValidVersion,
  maxSatisfyingVersion,
  versionSatisfies,
} from '../../src/core/python/pep440.js';

describe('versionSatisfies', () => {
  it('follows PEP 440 ordering rules including the documented traps', () => {
    expect(versionSatisfies('1.26.4', '==1.26.4')).toBe(true);
    expect(versionSatisfies('1.26.4', '>=1.20,<2')).toBe(true);
    // Exclusive comparisons exclude post/dev releases of the boundary version.
    expect(versionSatisfies('1.0.post1', '>1.0')).toBe(false);
    expect(versionSatisfies('1.0.dev1', '<1.0')).toBe(false);
    // Epochs sort before release segments.
    expect(versionSatisfies('1!1.0', '>=2.0')).toBe(true);
    // Pre-releases are excluded from ranges unless the range mentions one.
    expect(versionSatisfies('2.0.0rc1', '>=1.0')).toBe(false);
    expect(versionSatisfies('2.0.0rc1', '>=2.0.0rc1')).toBe(true);
    // Local versions satisfy == on the public version.
    expect(versionSatisfies('1.0+cu118', '==1.0')).toBe(true);
    // Wildcard and compatible-release clauses.
    expect(versionSatisfies('1.4.5', '==1.4.*')).toBe(true);
    expect(versionSatisfies('1.4.5', '~=1.4.2')).toBe(true);
    expect(versionSatisfies('1.5.0', '~=1.4.2')).toBe(false);
  });

  it('treats an empty specifier set as matching any version', () => {
    expect(versionSatisfies('0.0.1', '')).toBe(true);
    expect(versionSatisfies('2.0.0rc1', '  ')).toBe(true);
  });
});

describe('isValidVersion', () => {
  it('accepts PEP 440 versions including epochs and local segments', () => {
    expect(isValidVersion('1.0')).toBe(true);
    expect(isValidVersion('1!2.0.post1.dev3+local.7')).toBe(true);
    expect(isValidVersion('v1.0')).toBe(true);
    expect(isValidVersion('not-a-version')).toBe(false);
  });
});

describe('isValidSpecifierSet', () => {
  it('validates comma-separated PEP 440 clauses', () => {
    expect(isValidSpecifierSet('>=1.0,<2')).toBe(true);
    expect(isValidSpecifierSet('==1.4.*')).toBe(true);
    expect(isValidSpecifierSet('~=1.4.2')).toBe(true);
    expect(isValidSpecifierSet('banana')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('zero-pads release segments', () => {
    expect(compareVersions('3.11', '3.11.0')).toBe(0);
    expect(compareVersions('3.9', '3.11')).toBeLessThan(0);
  });
});

describe('isPrereleaseVersion', () => {
  it('flags pre and dev releases but not post releases', () => {
    expect(isPrereleaseVersion('1.0rc1')).toBe(true);
    expect(isPrereleaseVersion('1.0.dev1')).toBe(true);
    expect(isPrereleaseVersion('1.0.post1')).toBe(false);
    expect(isPrereleaseVersion('1.0')).toBe(false);
  });
});

describe('maxSatisfyingVersion', () => {
  it('prefers final releases and falls back to pre-releases only when required', () => {
    expect(maxSatisfyingVersion(['1.4.2', '1.4.9', '1.5.0', '2.0.0rc1'], '~=1.4.2')).toBe('1.4.9');
    expect(maxSatisfyingVersion(['1.4.2', '2.0.0rc1'], '>=1.0')).toBe('1.4.2');
    expect(maxSatisfyingVersion(['2.0.0rc1'], '>=1.0')).toBe('2.0.0rc1');
    expect(maxSatisfyingVersion(['1.0', '2.0'], '')).toBe('2.0');
    expect(maxSatisfyingVersion(['1.0'], '>=2.0')).toBeNull();
  });
});
