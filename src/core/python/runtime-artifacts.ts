import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as fs from '../fs.js';

export interface PythonRuntimeArtifactInput {
  pythonVersion: string;
  sha256: string;
  url: string;
}

interface PythonRuntimeArtifact {
  file: string;
  pythonVersion: string;
  sha256: string;
  sourceUrl: string;
}

export interface PythonRuntimeManifest {
  schemaVersion: 1;
  createdAt: string;
  mirrorDirectory: string;
  runtimes: PythonRuntimeArtifact[];
}

function mirrorSuffix(url: URL): string {
  const marker = '/releases/download/';
  const index = url.pathname.indexOf(marker);
  if (index < 0) {
    throw new Error(`Python runtime URL must contain ${marker}`);
  }
  const suffix = decodeURIComponent(url.pathname.slice(index + marker.length));
  if (!suffix || suffix.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Python runtime URL has an unsafe mirror path: ${url.toString()}`);
  }
  return suffix;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return hash.digest('hex');
}

async function download(url: URL, targetPath: string): Promise<void> {
  const temporary = `${targetPath}.${String(process.pid)}.runtime.tmp`;
  await fs.ensureDir(path.dirname(targetPath));
  await fs.remove(temporary);
  try {
    if (url.protocol === 'file:') {
      await fs.copyFile(fileURLToPath(url), temporary);
    } else {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (response.status !== 200 || !response.body) {
        throw new Error(`Python runtime download failed with status ${String(response.status)}`);
      }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
    }
    await fs.rename(temporary, targetPath);
  } finally {
    await fs.remove(temporary);
  }
}

export async function transferPythonRuntimeArtifacts(options: {
  bundleDir: string;
  dryRun?: boolean;
  generatedAt?: string;
  inputs: PythonRuntimeArtifactInput[];
}): Promise<PythonRuntimeManifest | undefined> {
  if (options.inputs.length === 0) return undefined;
  const mirrorDirectory = 'python-runtime-mirror';
  const runtimes: PythonRuntimeArtifact[] = [];
  for (const input of options.inputs) {
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) {
      throw new Error('Python runtime SHA-256 must contain exactly 64 hexadecimal characters');
    }
    const url = new URL(input.url);
    if (!['file:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Python runtime URL must be a credential-free file, HTTP, or HTTPS URL');
    }
    const relativeFile = path.posix.join(mirrorDirectory, mirrorSuffix(url));
    const targetPath = path.join(options.bundleDir, relativeFile);
    const expected = input.sha256.toLowerCase();
    const existing = (await fs.pathExists(targetPath)) ? await hashFile(targetPath) : null;
    if (existing !== expected) {
      if (options.dryRun) {
        throw new Error(`${relativeFile} is missing or does not match during dry-run`);
      }
      await download(url, targetPath);
      const actual = await hashFile(targetPath);
      if (actual !== expected) {
        await fs.remove(targetPath);
        throw new Error(
          `Python runtime SHA-256 mismatch: expected ${expected}, received ${actual}`
        );
      }
    }
    runtimes.push({
      file: relativeFile,
      pythonVersion: input.pythonVersion,
      sha256: expected,
      sourceUrl: input.url,
    });
  }
  const manifest: PythonRuntimeManifest = {
    schemaVersion: 1,
    createdAt: options.generatedAt ?? new Date().toISOString(),
    mirrorDirectory,
    runtimes: runtimes.sort((left, right) => left.pythonVersion.localeCompare(right.pythonVersion)),
  };
  if (!options.dryRun) {
    await fs.writeJsonAtomic(path.join(options.bundleDir, 'python-runtime-manifest.json'), manifest, {
      spaces: 2,
    });
  }
  return manifest;
}

export async function verifyPythonRuntimeManifest(
  bundleDir: string,
  manifest: PythonRuntimeManifest
): Promise<string[]> {
  const errors: string[] = [];
  for (const runtime of manifest.runtimes) {
    if (
      path.isAbsolute(runtime.file) ||
      runtime.file.split(/[\\/]/u).includes('..') ||
      !runtime.file.startsWith(`${manifest.mirrorDirectory}/`)
    ) {
      errors.push(`Unsafe Python runtime artifact path: ${runtime.file}`);
      continue;
    }
    const filePath = path.join(bundleDir, runtime.file);
    if (!(await fs.pathExists(filePath))) {
      errors.push(`Missing Python runtime artifact: ${runtime.file}`);
    } else if ((await hashFile(filePath)) !== runtime.sha256) {
      errors.push(`Python runtime SHA-256 mismatch: ${runtime.file}`);
    }
  }
  return errors;
}
