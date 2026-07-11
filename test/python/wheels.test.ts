import { describe, expect, it } from 'vitest';
import {
  expandWheelTags,
  parseSdistFilename,
  parseWheelFilename,
} from '../../src/core/python/wheels.js';

describe('parseWheelFilename', () => {
  it('parses a platform-specific CPython wheel', () => {
    expect(parseWheelFilename('numpy-2.2.6-cp310-cp310-macosx_10_9_x86_64.whl')).toEqual({
      abiTags: ['cp310'],
      distribution: 'numpy',
      normalizedName: 'numpy',
      platformTags: ['macosx_10_9_x86_64'],
      pythonTags: ['cp310'],
      raw: 'numpy-2.2.6-cp310-cp310-macosx_10_9_x86_64.whl',
      version: '2.2.6',
    });
  });

  it('parses compressed tag sets', () => {
    const universal = parseWheelFilename('six-1.16.0-py2.py3-none-any.whl');
    expect(universal?.pythonTags).toEqual(['py2', 'py3']);

    const manylinux = parseWheelFilename(
      'pydantic_core-2.16.3-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'
    );
    expect(manylinux?.platformTags).toEqual(['manylinux_2_17_x86_64', 'manylinux2014_x86_64']);
    expect(manylinux?.normalizedName).toBe('pydantic-core');
  });

  it('parses abi3 and build-tag wheels', () => {
    const abi3 = parseWheelFilename('cryptography-42.0.5-cp39-abi3-musllinux_1_2_x86_64.whl');
    expect(abi3?.abiTags).toEqual(['abi3']);

    const buildTag = parseWheelFilename('foo-1.0-1-py3-none-any.whl');
    expect(buildTag?.buildTag).toBe('1');
    expect(buildTag?.version).toBe('1.0');
  });

  it('rejects filenames that are not valid wheels', () => {
    expect(parseWheelFilename('foo-1.0.tar.gz')).toBeUndefined();
    expect(parseWheelFilename('foo-1.0-py3-none.whl')).toBeUndefined();
    expect(parseWheelFilename('foo-1.0-x-py3-none-any.whl')).toBeUndefined();
    expect(parseWheelFilename('foo-notaversion-py3-none-any.whl')).toBeUndefined();
    expect(parseWheelFilename('foo-1.0-1-2-py3-none-any.whl')).toBeUndefined();
  });
});

describe('expandWheelTags', () => {
  it('produces the cross product of tag sets', () => {
    const wheel = parseWheelFilename(
      'pydantic_core-2.16.3-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'
    );
    expect(wheel && expandWheelTags(wheel)).toEqual([
      'cp311-cp311-manylinux_2_17_x86_64',
      'cp311-cp311-manylinux2014_x86_64',
    ]);
  });
});

describe('parseSdistFilename', () => {
  it('parses tarball and zip source distributions', () => {
    expect(parseSdistFilename('numpy-2.2.6.tar.gz')).toEqual({
      distribution: 'numpy',
      normalizedName: 'numpy',
      raw: 'numpy-2.2.6.tar.gz',
      version: '2.2.6',
    });
    expect(parseSdistFilename('typing_extensions-4.12.2.zip')?.normalizedName).toBe(
      'typing-extensions'
    );
  });

  it('rejects non-sdist filenames', () => {
    expect(parseSdistFilename('numpy-2.2.6-cp310-cp310-macosx_10_9_x86_64.whl')).toBeUndefined();
    expect(parseSdistFilename('README.md')).toBeUndefined();
    expect(parseSdistFilename('foo.tar.gz')).toBeUndefined();
  });
});
