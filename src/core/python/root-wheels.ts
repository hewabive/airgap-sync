import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as fs from '../fs.js';
import type { PythonRootWheelInput, PythonRequirementInput } from './input-types.js';
import type {
  PythonIndexClient,
  PythonIndexFile,
  PythonMetadataResult,
  PythonProjectIndex,
} from './index-client.js';
import type { PythonMetadataCache, PythonCoreMetadata } from './metadata.js';
import { parseCoreMetadata } from './metadata.js';
import { normalizePackageName } from './names.js';
import { compareVersions } from './pep440.js';
import { parseRequirement } from './requirements.js';
import { readWheelMetadata } from './wheel-metadata.js';
import { parseWheelFilename } from './wheels.js';

export interface PreparedPythonRootWheel {
  file: PythonIndexFile;
  metadata: PythonCoreMetadata;
  requirement: PythonRequirementInput;
}

function rootFilename(url: string): string {
  const parsed = new URL(url);
  if (!['file:', 'http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Python root wheel URL must use file, HTTP, or HTTPS: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Python root wheel URL must not contain credentials');
  }
  const filename = decodeURIComponent(path.posix.basename(parsed.pathname));
  if (!parseWheelFilename(filename)) {
    throw new Error(`Python root wheel URL does not name a valid wheel: ${url}`);
  }
  return filename;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return hash.digest('hex');
}

async function copyOrDownload(url: string, targetPath: string): Promise<void> {
  const parsed = new URL(url);
  await fs.ensureDir(path.dirname(targetPath));
  const temporary = `${targetPath}.${String(process.pid)}.root-wheel.tmp`;
  await fs.remove(temporary);
  try {
    if (parsed.protocol === 'file:') {
      await fs.copyFile(fileURLToPath(parsed), temporary);
    } else {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (response.status !== 200 || !response.body) {
        throw new Error(`Root wheel download failed with status ${String(response.status)}`);
      }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
    }
    await fs.rename(temporary, targetPath);
  } finally {
    await fs.remove(temporary);
  }
}

async function ensureRootWheel(
  input: PythonRootWheelInput,
  bundleDir: string,
  dryRun: boolean
): Promise<string> {
  const filename = rootFilename(input.url);
  const targetPath = path.join(bundleDir, 'python-packages', filename);
  if (await fs.pathExists(targetPath)) {
    const actual = await sha256File(targetPath);
    if (actual === input.sha256.toLowerCase()) return targetPath;
    if (dryRun) throw new Error(`${filename} exists but its SHA-256 does not match`);
  } else if (dryRun) {
    throw new Error(`${filename} must already exist in the bundle for a dry-run`);
  }
  await copyOrDownload(input.url, targetPath);
  const actual = await sha256File(targetPath);
  if (actual !== input.sha256.toLowerCase()) {
    await fs.remove(targetPath);
    throw new Error(
      `${filename} SHA-256 mismatch: expected ${input.sha256.toLowerCase()}, received ${actual}`
    );
  }
  return targetPath;
}

export async function preparePythonRootWheels(options: {
  bundleDir: string;
  dryRun?: boolean;
  inputs: PythonRootWheelInput[];
}): Promise<PreparedPythonRootWheel[]> {
  const prepared: PreparedPythonRootWheel[] = [];
  for (const input of options.inputs) {
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) {
      throw new Error('Python root wheel SHA-256 must contain exactly 64 hexadecimal characters');
    }
    const filename = rootFilename(input.url);
    const wheel = parseWheelFilename(filename)!;
    const filePath = await ensureRootWheel(input, options.bundleDir, options.dryRun === true);
    const metadata = parseCoreMetadata(await readWheelMetadata(filePath));
    if (
      normalizePackageName(metadata.name) !== wheel.normalizedName ||
      compareVersions(metadata.version, wheel.version) !== 0
    ) {
      throw new Error(`Root wheel METADATA does not match ${filename}`);
    }
    const parsed = parseRequirement(`${metadata.name}==${metadata.version}`);
    if (!parsed.ok || parsed.requirement.url) {
      throw new Error(`Unable to create an exact requirement for ${filename}`);
    }
    prepared.push({
      file: {
        filename,
        hashes: { sha256: input.sha256.toLowerCase() },
        url: input.url,
      },
      metadata,
      requirement: {
        constraint: false,
        hashes: [{ algorithm: 'sha256', digest: input.sha256.toLowerCase() }],
        line: input.line,
        requiredBy: input.requiredBy,
        requirement: parsed.requirement,
        sourcePath: input.sourcePath,
      },
    });
  }
  return prepared;
}

export class RootWheelPythonIndex implements PythonIndexClient {
  readonly sourceIndex: string;
  readonly #delegate: PythonIndexClient;
  readonly #roots: Map<string, PreparedPythonRootWheel>;

  constructor(delegate: PythonIndexClient, roots: PreparedPythonRootWheel[]) {
    this.#delegate = delegate;
    this.sourceIndex = delegate.sourceIndex;
    this.#roots = new Map(roots.map((root) => [normalizePackageName(root.metadata.name), root]));
  }

  getProject(name: string): Promise<PythonProjectIndex> {
    const root = this.#roots.get(normalizePackageName(name));
    return root
      ? Promise.resolve({ apiVersion: 'root-wheel', files: [root.file], name })
      : this.#delegate.getProject(name);
  }

  getMetadata(
    file: PythonIndexFile,
    cache: PythonMetadataCache
  ): Promise<PythonMetadataResult> {
    const root = [...this.#roots.values()].find(
      (candidate) => candidate.file.url === file.url && candidate.file.filename === file.filename
    );
    return root
      ? Promise.resolve({ metadata: root.metadata, source: 'wheel' })
      : this.#delegate.getMetadata(file, cache);
  }
}
