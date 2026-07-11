import { describe, expect, it } from 'vitest';
import {
  digestBuffer,
  normalizeHashes,
  selectStrongHash,
  verifyBufferHash,
} from '../../src/core/python/integrity.js';

describe('Python integrity helpers', () => {
  it('normalizes hashes and selects the strongest supported algorithm', () => {
    const sha256 = 'aa'.repeat(32);
    const sha512 = 'bb'.repeat(64);
    const hashes = normalizeHashes({ MD5: 'not-hex', SHA256: sha256, sha512 });
    expect(hashes).toEqual({ sha256, sha512 });
    expect(selectStrongHash(hashes)).toEqual({ algorithm: 'sha512', digest: sha512 });
    expect(selectStrongHash({ sha256: 'aa' })).toBeUndefined();
  });

  it('verifies buffers', () => {
    const data = Buffer.from('demo');
    const digest = digestBuffer(data, 'sha256');
    expect(() => {
      verifyBufferHash(data, { algorithm: 'sha256', digest });
    }).not.toThrow();
    expect(() => {
      verifyBufferHash(data, { algorithm: 'sha256', digest: '00' });
    }).toThrow(/mismatch/);
  });
});
