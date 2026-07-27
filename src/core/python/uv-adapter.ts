import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { semanticDigest } from '../canonical-json.js';
import * as fs from '../fs.js';
import type { PythonLockInput } from './input-types.js';
import type { BuiltInPlatformFamilyId } from './platform-family.js';
import { parsePylock } from './pylock.js';
import { uvToolManifest } from './uv-tool.js';

export interface UvCommandInvocation {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface UvCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type UvCommandRunner = (invocation: UvCommandInvocation) => Promise<UvCommandResult>;

export type UvResolutionErrorKind = 'invalid-input' | 'no-solution' | 'no-wheel' | 'tool-failure';

export class UvResolutionError extends Error {
  readonly kind: UvResolutionErrorKind;
  readonly stderr: string;

  constructor(kind: UvResolutionErrorKind, message: string, stderr = '') {
    super(message);
    this.name = 'UvResolutionError';
    this.kind = kind;
    this.stderr = stderr;
  }
}

export interface UvResolveRequest {
  cacheDir: string;
  cutoff?: string;
  glibc?: string;
  platformFamilyId: BuiltInPlatformFamilyId;
  pythonMinor: string;
  requirement: string;
  sourceIndex: string;
  uvPath: string;
  workDir: string;
}

export interface UvResolutionEvidence {
  content: string;
  digest: string;
  lock: PythonLockInput;
  platformTarget: string;
}

export interface PythonApplicationResolver {
  resolve(request: UvResolveRequest): Promise<UvResolutionEvidence>;
}

export const defaultUvCommandRunner: UvCommandRunner = async (invocation) =>
  new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });

function validatePythonMinor(value: string): string {
  if (!/^3\.\d+$/u.test(value)) {
    throw new UvResolutionError('invalid-input', `Python minor must use 3.X form: ${value}`);
  }
  return value;
}

export function uvPlatformTarget(
  platformFamilyId: BuiltInPlatformFamilyId,
  glibc?: string
): string {
  if (platformFamilyId === 'windows-x86_64') {
    if (glibc !== undefined) {
      throw new UvResolutionError(
        'invalid-input',
        'Windows uv targets cannot declare a glibc baseline'
      );
    }
    return 'x86_64-pc-windows-msvc';
  }
  const baseline = glibc ?? '2.17';
  if (!/^2\.\d+$/u.test(baseline)) {
    throw new UvResolutionError('invalid-input', `Invalid glibc baseline: ${baseline}`);
  }
  const minor = /^2\.(\d+)$/u.exec(baseline)![1]!;
  return `x86_64-manylinux_2_${minor}`;
}

export function createUvCompileInvocation(
  request: UvResolveRequest,
  inputPath: string,
  outputPath: string,
  commandRunnerEnvironment: NodeJS.ProcessEnv = process.env
): UvCommandInvocation {
  const platformTarget = uvPlatformTarget(request.platformFamilyId, request.glibc);
  return {
    args: [
      'pip',
      'compile',
      inputPath,
      '--python-version',
      validatePythonMinor(request.pythonMinor),
      '--python-platform',
      platformTarget,
      '--only-binary=:all:',
      '--format',
      'pylock.toml',
      '--no-header',
      '--quiet',
      '--index-url',
      request.sourceIndex,
      ...(request.cutoff ? ['--exclude-newer', request.cutoff] : []),
      '--output-file',
      outputPath,
    ],
    command: request.uvPath,
    cwd: request.workDir,
    env: {
      ...commandRunnerEnvironment,
      UV_CACHE_DIR: path.resolve(request.cacheDir),
      UV_NO_CONFIG: '1',
      UV_NO_PROGRESS: '1',
      UV_NO_SYSTEM_CONFIG: '1',
      UV_PYTHON_BIN_DIR: path.join(path.resolve(request.cacheDir), 'python-bin'),
      UV_PYTHON_INSTALL_DIR: path.join(path.resolve(request.cacheDir), 'python'),
    },
  };
}

export function classifyUvResolutionFailure(stderr: string): UvResolutionErrorKind {
  if (/no solution found|requirements are unsatisfiable/iu.test(stderr)) {
    return 'no-solution';
  }
  if (
    /no wheels? (?:are|is )?available|source distributions are disabled|only wheels/iu.test(stderr)
  ) {
    return 'no-wheel';
  }
  return 'tool-failure';
}

export class UvApplicationResolver implements PythonApplicationResolver {
  readonly #commandRunner: UvCommandRunner;
  readonly #verifiedExecutables = new Set<string>();

  constructor(commandRunner: UvCommandRunner = defaultUvCommandRunner) {
    this.#commandRunner = commandRunner;
  }

  async #verifyExecutable(request: UvResolveRequest): Promise<void> {
    if (this.#verifiedExecutables.has(request.uvPath)) {
      return;
    }
    const result = await this.#commandRunner({
      args: ['--version'],
      command: request.uvPath,
      cwd: request.workDir,
      env: {
        ...process.env,
        UV_NO_CONFIG: '1',
        UV_NO_SYSTEM_CONFIG: '1',
      },
    });
    const version = result.stdout.trim();
    if (
      result.exitCode !== 0 ||
      (version !== `uv ${uvToolManifest.version}` &&
        !version.startsWith(`uv ${uvToolManifest.version} `))
    ) {
      throw new UvResolutionError(
        'tool-failure',
        `Expected uv ${uvToolManifest.version}, received ${version || result.stderr.trim() || `exit ${String(result.exitCode)}`}`,
        result.stderr
      );
    }
    this.#verifiedExecutables.add(request.uvPath);
  }

  async resolve(request: UvResolveRequest): Promise<UvResolutionEvidence> {
    if (/[\r\n]/u.test(request.requirement)) {
      throw new UvResolutionError('invalid-input', 'Application requirement must fit on one line');
    }
    await fs.ensureDir(request.workDir);
    await fs.ensureDir(request.cacheDir);
    await this.#verifyExecutable(request);
    const inputPath = path.join(request.workDir, 'requirements.in');
    const outputPath = path.join(request.workDir, 'pylock.toml');
    await fs.writeFile(inputPath, `${request.requirement}\n`);
    const invocation = createUvCompileInvocation(request, inputPath, outputPath);
    const result = await this.#commandRunner(invocation);
    if (result.exitCode !== 0) {
      const kind = classifyUvResolutionFailure(result.stderr);
      throw new UvResolutionError(
        kind,
        `uv could not resolve ${request.requirement} for ${request.platformFamilyId} on Python ${request.pythonMinor}`,
        result.stderr
      );
    }
    if (!(await fs.pathExists(outputPath))) {
      throw new UvResolutionError(
        'tool-failure',
        'uv reported success without writing pylock.toml',
        result.stderr
      );
    }
    const content = await fs.readFile(outputPath, 'utf8');
    const lock = parsePylock(content, outputPath);
    if (
      !lock.createdBy?.startsWith(`uv ${uvToolManifest.version}`) &&
      !lock.createdBy?.startsWith('uv')
    ) {
      throw new UvResolutionError(
        'tool-failure',
        `pylock.toml was not created by uv ${uvToolManifest.version}`
      );
    }
    return {
      content,
      digest: semanticDigest(content),
      lock,
      platformTarget: uvPlatformTarget(request.platformFamilyId, request.glibc),
    };
  }
}
