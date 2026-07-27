import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const bundleDir = path.resolve(process.argv[2] ?? './airgap-bundle');
const passArgument = process.argv.find((argument) => argument.startsWith('--passes='));
const passes = Number.parseInt(passArgument?.slice('--passes='.length) ?? '2', 10);
if (!Number.isSafeInteger(passes) || passes < 1 || passes > 10) {
  throw new Error('--passes must be an integer from 1 through 10');
}

const indexPath = path.join(bundleDir, 'python/application-index.json');
const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
if (typeof index !== 'object' || index === null || !Array.isArray(index.artifacts)) {
  throw new Error(`${indexPath} is not a Python application bundle index`);
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return {
    sha256: hash.digest('hex'),
    size,
  };
}

const results = [];
for (let pass = 1; pass <= passes; pass++) {
  let bytes = 0;
  const startedAt = performance.now();
  for (const artifact of index.artifacts) {
    if (
      typeof artifact.file !== 'string' ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      artifact.file.includes('\\') ||
      artifact.file.split('/').includes('..') ||
      path.posix.isAbsolute(artifact.file)
    ) {
      throw new Error('Python application index contains an unsafe artifact entry');
    }
    const measured = await hashFile(path.join(bundleDir, artifact.file));
    if (measured.sha256 !== artifact.sha256) {
      throw new Error(`SHA-256 mismatch while reading ${artifact.file}`);
    }
    bytes += measured.size;
  }
  const durationMs = performance.now() - startedAt;
  results.push({
    bytes,
    durationMs: Math.round(durationMs),
    mebibytesPerSecond:
      durationMs === 0
        ? null
        : Math.round((bytes / (1024 * 1024) / (durationMs / 1000)) * 100) / 100,
    pass,
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      artifacts: index.artifacts.length,
      bundle: bundleDir,
      mode: 'sequential-read-and-sha256',
      note: 'Run this command against the actual removable-media mount; the first pass includes cold-cache and media effects, while later passes may be cached by the OS.',
      passes: results,
      schemaVersion: 1,
    },
    null,
    2
  )}\n`
);
