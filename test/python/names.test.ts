import { describe, expect, it } from 'vitest';
import {
  escapePackageNameForFilename,
  isValidPackageName,
  normalizePackageName,
} from '../../src/core/python/names.js';

describe('normalizePackageName', () => {
  it('lowercases and collapses separator runs to single dashes', () => {
    expect(normalizePackageName('Django')).toBe('django');
    expect(normalizePackageName('typing_extensions')).toBe('typing-extensions');
    expect(normalizePackageName('foo.bar_baz')).toBe('foo-bar-baz');
    expect(normalizePackageName('ruamel.yaml')).toBe('ruamel-yaml');
    expect(normalizePackageName('a--b__c..d')).toBe('a-b-c-d');
  });
});

describe('escapePackageNameForFilename', () => {
  it('replaces dashes with underscores after normalization', () => {
    expect(escapePackageNameForFilename('pydantic-core')).toBe('pydantic_core');
    expect(escapePackageNameForFilename('ruamel.yaml')).toBe('ruamel_yaml');
  });
});

describe('isValidPackageName', () => {
  it('accepts PEP 508 names and rejects everything else', () => {
    expect(isValidPackageName('requests')).toBe(true);
    expect(isValidPackageName('A')).toBe(true);
    expect(isValidPackageName('zope.interface')).toBe(true);
    expect(isValidPackageName('foo_bar-2')).toBe(true);
    expect(isValidPackageName('-requests')).toBe(false);
    expect(isValidPackageName('requests-')).toBe(false);
    expect(isValidPackageName('re quests')).toBe(false);
    expect(isValidPackageName('requests\n')).toBe(false);
    expect(isValidPackageName('')).toBe(false);
  });
});
