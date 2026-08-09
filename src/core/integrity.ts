import { createHash, type Hash } from 'node:crypto';
import * as fs from './fs.js';

type DigestAlgorithm = 'sha1' | 'sha256' | 'sha384' | 'sha512';

export interface PackageIntegrityExpectation {
  integrity?: string;
  sha256?: string;
  shasum?: string;
}

export interface FileDigests {
  sha1?: string;
  sha1Base64?: string;
  sha256: string;
  sha256Base64: string;
  sha384Base64?: string;
  sha512Base64?: string;
}

export interface FileDigestCollector {
  digest(): FileDigests;
  update(chunk: Buffer): void;
}

interface SriEntry {
  algorithm: DigestAlgorithm;
  digest: string;
}

const sriAlgorithmStrength: Record<DigestAlgorithm, number> = {
  sha1: 1,
  sha256: 2,
  sha384: 3,
  sha512: 4,
};

function isDigestAlgorithm(value: string): value is DigestAlgorithm {
  return value in sriAlgorithmStrength;
}

function parseSriEntries(integrity: string): SriEntry[] {
  const entries = integrity
    .trim()
    .split(/\s+/u)
    .map((token) => token.split('?')[0] ?? '')
    .map((token) => {
      const separator = token.indexOf('-');
      if (separator <= 0) return undefined;
      const algorithm = token.slice(0, separator);
      return isDigestAlgorithm(algorithm)
        ? { algorithm, digest: token.slice(separator + 1) }
        : undefined;
    })
    .filter((entry): entry is SriEntry => entry !== undefined);

  if (entries.length === 0) {
    throw new Error(`Unsupported or malformed npm integrity value: ${integrity}`);
  }
  return entries;
}

function requiredDigestAlgorithms(expected: PackageIntegrityExpectation): Set<DigestAlgorithm> {
  const algorithms = new Set<DigestAlgorithm>(['sha256']);
  if (expected.shasum) algorithms.add('sha1');
  if (expected.integrity) {
    const entries = parseSriEntries(expected.integrity);
    const strongest = Math.max(...entries.map(({ algorithm }) => sriAlgorithmStrength[algorithm]));
    for (const entry of entries) {
      if (sriAlgorithmStrength[entry.algorithm] === strongest) {
        algorithms.add(entry.algorithm);
      }
    }
  }
  return algorithms;
}

export function fileDigestAlgorithmsKey(expected: PackageIntegrityExpectation = {}): string {
  return [...requiredDigestAlgorithms(expected)].sort().join(',');
}

export function createFileDigestCollector(
  expected: PackageIntegrityExpectation = {}
): FileDigestCollector {
  const hashers = new Map<DigestAlgorithm, Hash>(
    [...requiredDigestAlgorithms(expected)].map((algorithm) => [algorithm, createHash(algorithm)])
  );
  let finished = false;

  return {
    digest() {
      if (finished) throw new Error('File digest collector was already finalized');
      finished = true;
      const values = new Map<DigestAlgorithm, Buffer>();
      for (const [algorithm, hasher] of hashers) {
        values.set(algorithm, hasher.digest());
      }
      const sha256 = values.get('sha256');
      if (!sha256) throw new Error('SHA-256 digest was not computed');
      const sha1 = values.get('sha1');
      const sha384 = values.get('sha384');
      const sha512 = values.get('sha512');
      return {
        ...(sha1 ? { sha1: sha1.toString('hex'), sha1Base64: sha1.toString('base64') } : {}),
        sha256: sha256.toString('hex'),
        sha256Base64: sha256.toString('base64'),
        ...(sha384 ? { sha384Base64: sha384.toString('base64') } : {}),
        ...(sha512 ? { sha512Base64: sha512.toString('base64') } : {}),
      };
    },
    update(chunk) {
      if (finished) throw new Error('File digest collector was already finalized');
      for (const hasher of hashers.values()) hasher.update(chunk);
    },
  };
}

export async function computeFileDigests(
  filePath: string,
  expected: PackageIntegrityExpectation = {}
): Promise<FileDigests> {
  const collector = createFileDigestCollector(expected);
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => {
      collector.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return collector.digest();
}

function sriMatches(integrity: string, digests: FileDigests): boolean {
  const expected = parseSriEntries(integrity);
  const strongest = Math.max(...expected.map(({ algorithm }) => sriAlgorithmStrength[algorithm]));
  return expected.some(({ algorithm, digest }) => {
    if (sriAlgorithmStrength[algorithm] !== strongest) return false;
    if (algorithm === 'sha512') return digest === digests.sha512Base64;
    if (algorithm === 'sha384') return digest === digests.sha384Base64;
    if (algorithm === 'sha256') return digest === digests.sha256Base64;
    return digest === digests.sha1Base64;
  });
}

export function verifyComputedPackageIntegrity(
  digests: FileDigests,
  expected: PackageIntegrityExpectation,
  subject: string
): void {
  if (expected.integrity && !sriMatches(expected.integrity, digests)) {
    throw new Error(`Tarball integrity mismatch for ${subject}`);
  }
  if (expected.shasum && expected.shasum.toLowerCase() !== digests.sha1) {
    throw new Error(`Tarball shasum mismatch for ${subject}`);
  }
  if (expected.sha256 && expected.sha256.toLowerCase() !== digests.sha256) {
    throw new Error(`Tarball SHA-256 mismatch for ${subject}`);
  }
}
