import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from '../fs.js';
import { downloadResumableHttpFile } from '../resumable-download.js';
import type { PythonEnvironmentPlan, PythonPlanTransferArtifact } from './environment-plan.js';

export interface PythonPlanArtifactManifestEntry extends PythonPlanTransferArtifact {
  file: string;
  status: 'downloaded' | 'existing' | 'would-download';
}

export interface PythonPlanArtifactManifest {
  artifacts: PythonPlanArtifactManifestEntry[];
  createdAt: string;
  directory: string;
  planId: string;
  schemaVersion: 1;
}

export interface TransferPythonPlanArtifactsOptions {
  bundleDir: string;
  dryRun?: boolean;
  fetch?: typeof globalThis.fetch;
  generatedAt?: string;
  plan: PythonEnvironmentPlan;
  retryDelaysMs?: number[];
}

async function hashFile(filePath: string): Promise<{
  sha256: string;
  size: number;
}> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    hash.update(buffer);
    size += buffer.byteLength;
  }
  return {
    sha256: hash.digest('hex'),
    size,
  };
}

function artifactFile(directory: string, artifact: PythonPlanTransferArtifact): string {
  if (
    !artifact.filename ||
    artifact.filename.includes('/') ||
    artifact.filename.includes('\\') ||
    artifact.filename.includes('\0')
  ) {
    throw new Error(`Unsafe Python plan artifact filename: ${artifact.filename}`);
  }
  return path.posix.join(directory, artifact.sha256, artifact.filename);
}

async function downloadArtifact(
  artifact: PythonPlanTransferArtifact,
  targetPath: string,
  options: Pick<TransferPythonPlanArtifactsOptions, 'fetch' | 'retryDelaysMs'>
): Promise<void> {
  const partialPath = `${targetPath}.download.partial`;
  await fs.ensureDir(path.dirname(targetPath));
  const url = new URL(artifact.sourceUrl);
  if (url.username || url.password) {
    throw new Error('Python plan artifact URLs must not contain credentials');
  }
  const validateFile = async (filePath: string): Promise<void> => {
    const actual = await hashFile(filePath);
    if (actual.sha256 !== artifact.sha256) {
      throw new Error(
        `Python plan artifact SHA-256 mismatch for ${artifact.filename}: expected ${artifact.sha256}, received ${actual.sha256}`
      );
    }
    if (artifact.size !== undefined && actual.size !== artifact.size) {
      throw new Error(
        `Python plan artifact size mismatch for ${artifact.filename}: expected ${String(artifact.size)}, received ${String(actual.size)}`
      );
    }
  };
  if (url.protocol === 'file:') {
    await fs.copyFile(fileURLToPath(url), partialPath);
    try {
      await validateFile(partialPath);
    } catch (error) {
      await fs.remove(partialPath);
      throw error;
    }
    await fs.remove(targetPath);
    await fs.rename(partialPath, targetPath);
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported Python plan artifact URL: ${url.toString()}`);
  }
  await downloadResumableHttpFile({
    ...(artifact.size === undefined ? {} : { expectedSize: artifact.size }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    targetPath,
    url,
    validateFile,
  });
}

export async function transferPythonPlanArtifacts(
  options: TransferPythonPlanArtifactsOptions
): Promise<PythonPlanArtifactManifest | undefined> {
  if (!options.plan.runtimeArtifacts?.length) {
    return undefined;
  }
  const directory = 'python/artifacts';
  const artifacts: PythonPlanArtifactManifestEntry[] = [];
  for (const artifact of options.plan.runtimeArtifacts) {
    if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
      throw new Error(`Invalid Python plan artifact SHA-256: ${artifact.filename}`);
    }
    const file = artifactFile(directory, artifact);
    const targetPath = path.join(options.bundleDir, file);
    const existing = (await fs.pathExists(targetPath)) ? await hashFile(targetPath) : undefined;
    const matches =
      existing?.sha256 === artifact.sha256 &&
      (artifact.size === undefined || existing.size === artifact.size);
    let status: PythonPlanArtifactManifestEntry['status'];
    if (matches) {
      status = 'existing';
    } else if (options.dryRun) {
      status = 'would-download';
    } else {
      await downloadArtifact(artifact, targetPath, options);
      status = 'downloaded';
    }
    artifacts.push({
      ...artifact,
      file,
      status,
    });
  }
  const manifest: PythonPlanArtifactManifest = {
    artifacts,
    createdAt: options.generatedAt ?? new Date().toISOString(),
    directory,
    planId: options.plan.planId,
    schemaVersion: 1,
  };
  if (!options.dryRun) {
    await fs.writeJsonAtomic(
      path.join(options.bundleDir, 'python-plan-artifact-manifest.json'),
      manifest,
      { spaces: 2 }
    );
  }
  return manifest;
}

export async function verifyPythonPlanArtifactManifest(
  bundleDir: string,
  manifest: PythonPlanArtifactManifest
): Promise<string[]> {
  const errors: string[] = [];
  for (const artifact of manifest.artifacts) {
    if (
      path.isAbsolute(artifact.file) ||
      artifact.file.split(/[\\/]/u).includes('..') ||
      !artifact.file.startsWith(`${manifest.directory}/`)
    ) {
      errors.push(`Unsafe Python plan artifact path: ${artifact.file}`);
      continue;
    }
    const filePath = path.join(bundleDir, artifact.file);
    if (!(await fs.pathExists(filePath))) {
      errors.push(`Missing Python plan artifact: ${artifact.file}`);
      continue;
    }
    const actual = await hashFile(filePath);
    if (actual.sha256 !== artifact.sha256) {
      errors.push(`Python plan artifact SHA-256 mismatch: ${artifact.file}`);
    }
    if (artifact.size !== undefined && actual.size !== artifact.size) {
      errors.push(`Python plan artifact size mismatch: ${artifact.file}`);
    }
  }
  return errors;
}
