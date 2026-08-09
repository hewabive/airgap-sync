import { createHash } from 'node:crypto';
import path from 'node:path';
import * as fs from '../fs.js';
import type { VerifyCheck } from '../../types.js';
import type { PythonSeedManifest } from './bundle.js';
import { normalizePackageName } from './names.js';
import { compareVersions } from './pep440.js';
import { parseWheelFilename } from './wheels.js';

function check(
  name: string,
  status: VerifyCheck['status'],
  message: string,
  details?: unknown
): VerifyCheck {
  return { ...(details === undefined ? {} : { details }), message, name, status };
}

function safeBundleFile(bundleDir: string, relativeFile: string): string | undefined {
  const normalized = path.posix.normalize(relativeFile.replace(/\\/g, '/'));
  const v2Match = /^python\/artifacts\/wheels\/([a-f0-9]{64})\/([^/]+\.whl)$/u.exec(normalized);
  if (
    normalized !== relativeFile ||
    !v2Match ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes('\0')
  ) {
    return undefined;
  }
  const absolute = path.resolve(bundleDir, normalized);
  const relative = path.relative(bundleDir, absolute);
  return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : absolute;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return hash.digest('hex');
}

export async function verifyPythonBundle(options: {
  bundleDir: string;
  manifest: PythonSeedManifest;
}): Promise<VerifyCheck[]> {
  const issues: { error: string; file?: string; package?: string }[] = [];
  const missing: string[] = [];
  const seenFiles = new Set<string>();
  let fileCount = 0;

  if ((options.manifest as { schemaVersion?: unknown }).schemaVersion !== 1) {
    issues.push({ error: 'Unsupported Python seed manifest schema version' });
  }
  for (const pkg of options.manifest.packages) {
    for (const file of pkg.files) {
      fileCount++;
      if (seenFiles.has(file.file)) {
        issues.push({ error: 'Duplicate Python bundle file path', file: file.file });
        continue;
      }
      seenFiles.add(file.file);
      const filePath = safeBundleFile(options.bundleDir, file.file);
      if (!filePath || path.posix.basename(file.file) !== file.filename) {
        issues.push({ error: 'Unsafe or inconsistent Python bundle file path', file: file.file });
        continue;
      }
      const v2Digest = /^python\/artifacts\/wheels\/([a-f0-9]{64})\//u.exec(file.file)?.[1];
      if (v2Digest && v2Digest !== file.sha256.toLowerCase()) {
        issues.push({
          error: 'Python v2 artifact directory does not match its sha256',
          file: file.file,
        });
      }
      if (!(await fs.pathExists(filePath))) {
        missing.push(file.file);
        continue;
      }
      const wheel = parseWheelFilename(file.filename);
      if (!wheel) {
        issues.push({ error: 'Invalid wheel filename', file: file.file, package: pkg.name });
      } else if (
        wheel.normalizedName !== normalizePackageName(pkg.name) ||
        compareVersions(wheel.version, pkg.version) !== 0
      ) {
        issues.push({
          error: 'Wheel filename identity does not match its manifest package',
          file: file.file,
          package: `${pkg.name}@${pkg.version}`,
        });
      }
      if (
        normalizePackageName(file.coreMetadata.name) !== normalizePackageName(pkg.name) ||
        compareVersions(file.coreMetadata.version, pkg.version) !== 0
      ) {
        issues.push({
          error: 'Wheel Core Metadata identity does not match its manifest package',
          file: file.file,
          package: `${pkg.name}@${pkg.version}`,
        });
      }
      if ((await sha256(filePath)) !== file.sha256.toLowerCase()) {
        issues.push({ error: 'Wheel sha256 does not match the manifest', file: file.file });
      }
    }
  }

  const checks: VerifyCheck[] = [
    missing.length === 0
      ? check(
          'python-wheel-files',
          'ok',
          `${String(fileCount)}/${String(fileCount)} wheels are present`
        )
      : check(
          'python-wheel-files',
          'error',
          `${String(missing.length)}/${String(fileCount)} wheels are missing`,
          { missing }
        ),
    issues.length === 0
      ? check(
          'python-wheel-integrity',
          'ok',
          `${String(fileCount)} wheels passed identity and hash checks`
        )
      : check(
          'python-wheel-integrity',
          'error',
          `${String(issues.length)} Python manifest or wheel integrity errors`,
          {
            issues,
          }
        ),
  ];

  const coverage = options.manifest.packages.flatMap((pkg) =>
    pkg.files.some((file) => file.file.startsWith('python/artifacts/wheels/'))
      ? []
      : options.manifest.targetEnvironments.flatMap((environment) =>
          pkg.files.some((file) => file.environments.includes(environment.name))
            ? []
            : [{ environment: environment.name, package: `${pkg.name}@${pkg.version}` }]
        )
  );
  checks.push(
    coverage.length === 0
      ? check(
          'python-environment-coverage',
          'ok',
          'Every Python package has a wheel for every configured target environment'
        )
      : check(
          'python-environment-coverage',
          'warning',
          `${String(coverage.length)} package/environment combinations have no wheel`,
          { missing: coverage }
        )
  );

  return checks;
}
