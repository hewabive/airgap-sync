import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import {
  PythonMetadataCache,
  parseCoreMetadata,
  readPythonMetadataCache,
  writePythonMetadataCache,
} from '../../src/core/python/metadata.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

function metadataText(name = 'Demo', version = '1.2.3'): string {
  return [
    'Metadata-Version: 2.4',
    `Name: ${name}`,
    `Version: ${version}`,
    'Summary: A package',
    'Requires-Python: >=3.9',
    'Requires-Dist: first>=1',
    'Requires-Dist: second; python_version >= "3.10"',
    'Provides-Extra: speed-ups',
    'Project-URL: Homepage, https://example.test',
    'Author: Example',
    '',
    'Long description.',
  ].join('\n');
}

describe('parseCoreMetadata', () => {
  it('parses repeated, optional, and body fields', () => {
    expect(parseCoreMetadata(metadataText())).toEqual({
      author: 'Example',
      description: 'Long description.',
      metadataVersion: '2.4',
      name: 'Demo',
      projectUrls: ['Homepage, https://example.test'],
      providesExtra: ['speed-ups'],
      requiresDist: ['first>=1', 'second; python_version >= "3.10"'],
      requiresPython: '>=3.9',
      summary: 'A package',
      version: '1.2.3',
    });
  });

  it('unfolds continuation lines and rejects missing required fields', () => {
    const parsed = parseCoreMetadata(
      'Metadata-Version: 2.1\nName: Demo\nVersion: 1\nRequires-Dist: one;\n  python_version >= "3.9"'
    );
    expect(parsed.requiresDist).toEqual(['one; python_version >= "3.9"']);
    expect(() => parseCoreMetadata('Name: Demo\nVersion: 1')).toThrow(/Metadata-Version/);
  });
});

describe('PythonMetadataCache', () => {
  it('keys entries by source and artifact identity and clones values', () => {
    const cache = new PythonMetadataCache();
    const identity = {
      hashes: { sha256: 'aa' },
      sourceIndex: 'https://index.test/simple',
      url: 'https://index.test/files/demo.whl#sha256=aa',
    };
    const metadata = parseCoreMetadata(metadataText());
    cache.set(identity, metadata);
    metadata.requiresDist.push('mutated');

    expect(cache.get(identity)?.requiresDist).toEqual([
      'first>=1',
      'second; python_version >= "3.10"',
    ]);
    expect(cache.get({ ...identity, sourceIndex: 'https://other.test/simple' })).toBeUndefined();
  });

  it('round-trips only the requested source index', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-metadata-test-'));
    tempDirs.push(dir);
    const sourceIndex = 'https://index.test/simple';
    const identity = {
      hashes: { sha256: 'aa' },
      sourceIndex,
      url: 'https://index.test/files/demo.whl',
    };
    const cache = new PythonMetadataCache();
    cache.set(identity, parseCoreMetadata(metadataText()));
    await writePythonMetadataCache(dir, cache, {
      createdAt: '2026-07-10T00:00:00.000Z',
      sourceIndex,
    });

    expect((await readPythonMetadataCache(dir, sourceIndex)).get(identity)?.name).toBe('Demo');
    expect(
      (await readPythonMetadataCache(dir, 'https://other.test/simple')).get(identity)
    ).toBeUndefined();
  });
});
