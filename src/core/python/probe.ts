import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PythonEnvironmentPlan, PythonPlatformPlan } from './environment-plan.js';
import { compareCompatibilityVersions } from './coverage-explain.js';
import { versionSatisfies } from './pep440.js';

const execFileAsync = promisify(execFile);

export type ProbeArchitecture = 'aarch64' | 'x86_64' | 'unknown';
export type ProbeOsFamily = 'linux' | 'macos' | 'unknown' | 'windows';

export interface MachineProbeFacts {
  architecture: ProbeArchitecture;
  capabilities: Record<string, string>;
  libc?: {
    family: 'glibc' | 'musl';
    version: string;
  };
  os: ProbeOsFamily;
  python?: {
    command: string;
    version: string;
  };
}

export interface ProbeCommandResult {
  stderr: string;
  stdout: string;
}

export type ProbeCommandRunner = (command: string, args: string[]) => Promise<ProbeCommandResult>;

export interface ProbeCheck {
  actual?: string;
  message: string;
  name: 'architecture' | 'capability' | 'libc' | 'operating-system' | 'python';
  required?: string;
  status: 'error' | 'ok' | 'warning';
}

export interface ProbeComparison {
  checks: ProbeCheck[];
  facts: MachineProbeFacts;
  platformFamilyId?: string;
  status: 'compatible' | 'incompatible' | 'needs-action';
}

export interface ProbeMachineOptions {
  capabilities?: Record<string, string>;
  commandRunner?: ProbeCommandRunner;
  nodeArch?: NodeJS.Architecture;
  nodePlatform?: NodeJS.Platform;
  report?: {
    header?: {
      glibcVersionRuntime?: string;
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeMachineProbeFacts(value: unknown): MachineProbeFacts {
  if (!isRecord(value)) {
    throw new Error('probe facts must be a JSON object');
  }
  if (
    value.os !== 'linux' &&
    value.os !== 'macos' &&
    value.os !== 'windows' &&
    value.os !== 'unknown'
  ) {
    throw new Error('probe facts contain an unsupported OS family');
  }
  if (
    value.architecture !== 'aarch64' &&
    value.architecture !== 'x86_64' &&
    value.architecture !== 'unknown'
  ) {
    throw new Error('probe facts contain an unsupported architecture');
  }
  const capabilities: Record<string, string> = {};
  if (value.capabilities !== undefined) {
    if (!isRecord(value.capabilities)) {
      throw new Error('probe capabilities must be an object');
    }
    for (const [name, capability] of Object.entries(value.capabilities)) {
      if (typeof capability !== 'string' || !name.trim() || !capability.trim()) {
        throw new Error('probe capability keys and values must be non-empty strings');
      }
      capabilities[name.trim()] = capability.trim();
    }
  }

  let libc: MachineProbeFacts['libc'];
  if (value.libc !== undefined) {
    if (
      !isRecord(value.libc) ||
      (value.libc.family !== 'glibc' && value.libc.family !== 'musl') ||
      typeof value.libc.version !== 'string' ||
      !/^\d+\.\d+/u.test(value.libc.version)
    ) {
      throw new Error('probe libc fact must contain a family and version');
    }
    libc = {
      family: value.libc.family,
      version: /^\d+\.\d+/u.exec(value.libc.version)![0],
    };
  }

  let python: MachineProbeFacts['python'];
  if (value.python !== undefined) {
    if (
      !isRecord(value.python) ||
      typeof value.python.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/u.test(value.python.version) ||
      (value.python.command !== undefined && typeof value.python.command !== 'string')
    ) {
      throw new Error('probe Python fact must contain a full X.Y.Z version');
    }
    python = {
      command:
        typeof value.python.command === 'string' && value.python.command.trim()
          ? value.python.command.trim()
          : 'python',
      version: value.python.version,
    };
  }

  return {
    architecture: value.architecture,
    capabilities,
    ...(libc ? { libc } : {}),
    os: value.os,
    ...(python ? { python } : {}),
  };
}

const defaultCommandRunner: ProbeCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  return {
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

function normalizeArchitecture(architecture: NodeJS.Architecture): ProbeArchitecture {
  if (architecture === 'x64') {
    return 'x86_64';
  }
  if (architecture === 'arm64') {
    return 'aarch64';
  }
  return 'unknown';
}

function normalizeOsFamily(platform: NodeJS.Platform): ProbeOsFamily {
  if (platform === 'win32') {
    return 'windows';
  }
  if (platform === 'linux' || platform === 'darwin') {
    return platform === 'darwin' ? 'macos' : 'linux';
  }
  return 'unknown';
}

function parseLibcOutput(output: string): MachineProbeFacts['libc'] | undefined {
  if (/musl/iu.test(output)) {
    const version = /Version\s+(\d+\.\d+)/iu.exec(output)?.[1];
    return version ? { family: 'musl', version } : undefined;
  }
  const version =
    /(?:GLIBC|GNU C Library|GNU libc)[^\d]*(\d+\.\d+)/iu.exec(output)?.[1] ??
    /\b(\d+\.\d+)\b/u.exec(output)?.[1];
  return version ? { family: 'glibc', version } : undefined;
}

async function detectLibc(
  os: ProbeOsFamily,
  report: ProbeMachineOptions['report'],
  commandRunner: ProbeCommandRunner
): Promise<MachineProbeFacts['libc'] | undefined> {
  if (os !== 'linux') {
    return undefined;
  }
  const reportVersion = report?.header?.glibcVersionRuntime;
  if (reportVersion && /^\d+\.\d+/u.test(reportVersion)) {
    return {
      family: 'glibc',
      version: /^\d+\.\d+/u.exec(reportVersion)![0],
    };
  }
  try {
    const output = await commandRunner('ldd', ['--version']);
    return parseLibcOutput(`${output.stdout}\n${output.stderr}`);
  } catch {
    return undefined;
  }
}

async function detectPython(
  os: ProbeOsFamily,
  commandRunner: ProbeCommandRunner
): Promise<MachineProbeFacts['python'] | undefined> {
  const candidates =
    os === 'windows'
      ? [
          { args: ['-3', '--version'], command: 'py' },
          { args: ['--version'], command: 'python' },
        ]
      : [
          { args: ['--version'], command: 'python3' },
          { args: ['--version'], command: 'python' },
        ];
  for (const candidate of candidates) {
    try {
      const output = await commandRunner(candidate.command, candidate.args);
      const version = /Python\s+(\d+\.\d+\.\d+)/u.exec(`${output.stdout}\n${output.stderr}`)?.[1];
      if (version) {
        return {
          command: candidate.command,
          version,
        };
      }
    } catch {
      // A missing optional interpreter is represented by an absent python fact.
    }
  }
  return undefined;
}

export async function probeMachine(options: ProbeMachineOptions = {}): Promise<MachineProbeFacts> {
  const os = normalizeOsFamily(options.nodePlatform ?? process.platform);
  const architecture = normalizeArchitecture(options.nodeArch ?? process.arch);
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const report = options.report ?? process.report.getReport();
  const [libc, python] = await Promise.all([
    detectLibc(os, report, commandRunner),
    detectPython(os, commandRunner),
  ]);
  return {
    architecture,
    capabilities: { ...(options.capabilities ?? {}) },
    ...(libc ? { libc } : {}),
    os,
    ...(python ? { python } : {}),
  };
}

function expectedPlatformFamily(facts: MachineProbeFacts): string | undefined {
  if (facts.os === 'windows' && facts.architecture === 'x86_64') {
    return 'windows-x86_64';
  }
  if (facts.os === 'linux' && facts.architecture === 'x86_64' && facts.libc?.family === 'glibc') {
    return 'linux-glibc-x86_64';
  }
  return undefined;
}

function platformChecks(
  facts: MachineProbeFacts,
  platform: PythonPlatformPlan | undefined,
  platformFamilyId: string | undefined
): ProbeCheck[] {
  const checks: ProbeCheck[] = [];
  checks.push({
    actual: facts.os,
    message: platformFamilyId
      ? `OS maps to ${platformFamilyId}`
      : `OS family ${facts.os} is outside this plan's built-in coverage`,
    name: 'operating-system',
    status: platformFamilyId ? 'ok' : 'error',
  });
  checks.push({
    actual: facts.architecture,
    message:
      facts.architecture === 'x86_64'
        ? 'Architecture is supported'
        : 'Initial application coverage supports x86_64 only',
    name: 'architecture',
    required: 'x86_64',
    status: facts.architecture === 'x86_64' ? 'ok' : 'error',
  });
  if (platformFamilyId && !platform) {
    checks.push({
      actual: platformFamilyId,
      message: 'The environment plan does not request this platform family',
      name: 'operating-system',
      status: 'error',
    });
  } else if (platform?.status === 'rejected') {
    checks.push({
      actual: platform.platformFamilyId,
      message: platform.rejectedReasons.join('; ') || 'Platform branch was rejected',
      name: 'operating-system',
      status: 'error',
    });
  }
  return checks;
}

export function compareMachineToPythonEnvironmentPlan(
  facts: MachineProbeFacts,
  plan: PythonEnvironmentPlan
): ProbeComparison {
  const platformFamilyId = expectedPlatformFamily(facts);
  const platform = plan.platforms.find(
    (candidate) => candidate.platformFamilyId === platformFamilyId
  );
  const checks = platformChecks(facts, platform, platformFamilyId);

  if (facts.os === 'linux') {
    if (!facts.libc) {
      checks.push({
        message: 'Unable to determine the Linux libc family and version',
        name: 'libc',
        status: 'warning',
      });
    } else if (facts.libc.family !== 'glibc') {
      checks.push({
        actual: `${facts.libc.family} ${facts.libc.version}`,
        message: 'Initial Linux application coverage requires glibc',
        name: 'libc',
        required: 'glibc',
        status: 'error',
      });
    } else {
      const requiredGlibc = platform?.supportBoundary?.glibc;
      checks.push({
        actual: facts.libc.version,
        message: requiredGlibc
          ? compareCompatibilityVersions(facts.libc.version, requiredGlibc) >= 0
            ? 'glibc satisfies the environment plan'
            : 'glibc is older than the environment plan requires'
          : 'glibc detected; the plan declares no explicit minimum',
        name: 'libc',
        ...(requiredGlibc ? { required: requiredGlibc } : {}),
        status:
          requiredGlibc && compareCompatibilityVersions(facts.libc.version, requiredGlibc) < 0
            ? 'error'
            : 'ok',
      });
    }
  }

  if (platform) {
    if (!facts.python) {
      checks.push({
        message: 'A compatible Python interpreter must be provisioned externally',
        name: 'python',
        required: platform.requiresPython,
        status: 'warning',
      });
    } else {
      const compatible = versionSatisfies(facts.python.version, platform.requiresPython);
      checks.push({
        actual: facts.python.version,
        message: compatible
          ? 'Python satisfies the runtime contract'
          : 'Python does not satisfy the runtime contract',
        name: 'python',
        required: platform.requiresPython,
        status: compatible ? 'ok' : 'error',
      });
    }
  }

  const requiredCapabilities = {
    ...(plan.coverage.policy.features ?? {}),
    ...plan.intent.application.features,
  };
  for (const [name, required] of Object.entries(requiredCapabilities).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const actual = facts.capabilities[name];
    checks.push({
      ...(actual ? { actual } : {}),
      message:
        actual === undefined
          ? `Capability ${name} was not supplied to probe`
          : actual === required
            ? `Capability ${name} matches`
            : `Capability ${name} does not match`,
      name: 'capability',
      required,
      status: actual === undefined ? 'warning' : actual === required ? 'ok' : 'error',
    });
  }

  const status = checks.some((check) => check.status === 'error')
    ? 'incompatible'
    : checks.some((check) => check.status === 'warning')
      ? 'needs-action'
      : 'compatible';
  return {
    checks,
    facts,
    ...(platformFamilyId ? { platformFamilyId } : {}),
    status,
  };
}
