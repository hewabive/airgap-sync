import { createHash } from 'node:crypto';

export interface SelectedHash {
  algorithm: 'sha256' | 'sha384' | 'sha512';
  digest: string;
}

const supportedAlgorithms = ['sha512', 'sha384', 'sha256'] as const;
const digestLengths: Record<SelectedHash['algorithm'], number> = {
  sha256: 64,
  sha384: 96,
  sha512: 128,
};
const hexadecimalPattern = /^[a-fA-F0-9]+$/;

export function normalizeHashes(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const hashes: Record<string, string> = {};
  for (const [algorithm, digest] of Object.entries(value)) {
    if (
      typeof digest !== 'string' ||
      digest.length === 0 ||
      digest.length % 2 !== 0 ||
      !hexadecimalPattern.test(digest)
    ) {
      continue;
    }
    hashes[algorithm.toLowerCase()] = digest.toLowerCase();
  }
  return hashes;
}

export function selectStrongHash(hashes: Record<string, string>): SelectedHash | undefined {
  for (const algorithm of supportedAlgorithms) {
    const digest = hashes[algorithm];
    if (digest?.length === digestLengths[algorithm]) {
      return { algorithm, digest };
    }
  }
  return undefined;
}

export function digestBuffer(buffer: Uint8Array, algorithm: SelectedHash['algorithm']): string {
  return createHash(algorithm).update(buffer).digest('hex');
}

export function verifyBufferHash(buffer: Uint8Array, expected: SelectedHash): void {
  const actual = digestBuffer(buffer, expected.algorithm);
  if (actual !== expected.digest) {
    throw new Error(
      `${expected.algorithm} mismatch: expected ${expected.digest}, received ${actual}`
    );
  }
}
