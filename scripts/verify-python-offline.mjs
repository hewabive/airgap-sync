import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyPythonApplicationBundle } from '../dist/index.js';

const run = promisify(execFile);
const [bundleArgument, requirement, python = '3.12'] = process.argv.slice(2);
if (!bundleArgument || !requirement) {
  throw new Error(
    'Usage: node scripts/verify-python-offline.mjs BUNDLE REQUIREMENT [PYTHON] (UV_BIN selects uv)'
  );
}
const bundleDir = path.resolve(bundleArgument);
const verified = await verifyPythonApplicationBundle(bundleDir);
if (verified.errors.length > 0) throw new Error(verified.errors.join('\n'));
const manifest = JSON.parse(
  await fs.readFile(path.join(bundleDir, 'python-seed-manifest.json'), 'utf8')
);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-offline-install-'));
const uv = process.env.UV_BIN ?? 'uv';
const env = { ...process.env, UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'never', UV_OFFLINE: '1' };
try {
  const wheels = path.join(temp, 'wheels');
  await fs.mkdir(wheels);
  const filenames = new Map();
  for (const pkg of manifest.packages) {
    for (const file of pkg.files) {
      if (!file.filename.endsWith('.whl')) continue;
      const previous = filenames.get(file.filename);
      if (previous && previous !== file.sha256)
        throw new Error(`Conflicting wheel: ${file.filename}`);
      if (previous) continue;
      filenames.set(file.filename, file.sha256);
      // Hard links avoid another copy of multi-GB GPU wheels on the same filesystem.
      const source = path.resolve(bundleDir, file.file);
      const destination = path.join(wheels, file.filename);
      try {
        await fs.link(source, destination);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await fs.symlink(source, destination);
      }
    }
  }
  const venv = path.join(temp, 'venv');
  const pythonPath =
    process.platform === 'win32'
      ? path.join(venv, 'Scripts', 'python.exe')
      : path.join(venv, 'bin', 'python');
  const execute = async (args) => {
    const result = await run(uv, ['--offline', '--no-cache', ...args], {
      env,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    process.stderr.write(result.stderr);
    return result;
  };
  await execute(['venv', '--python', python, venv]);
  await execute([
    'pip',
    'install',
    '--python',
    pythonPath,
    '--no-index',
    '--find-links',
    wheels,
    '--only-binary=:all:',
    '--prerelease=allow',
    requirement,
  ]);
  await execute(['pip', 'check', '--python', pythonPath]);
  const installed = await execute(['pip', 'list', '--python', pythonPath, '--format', 'json']);
  process.stdout.write(
    `${JSON.stringify(
      {
        bundleDir,
        requirement,
        python,
        offline: true,
        artifactsVerified: verified.artifacts,
        installed: JSON.parse(installed.stdout),
        gpuRuntimeTested: false,
      },
      null,
      2
    )}\n`
  );
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
