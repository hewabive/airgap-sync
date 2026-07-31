import { describe, expect, it } from 'vitest';
import type {
  PythonIndexClient,
  PythonIndexFile,
  PythonMetadataResult,
  PythonProjectIndex,
} from '../../src/core/python/index-client.js';
import { PythonMetadataCache, type PythonCoreMetadata } from '../../src/core/python/metadata.js';
import { parseRequirement } from '../../src/core/python/requirements.js';
import { resolvePython } from '../../src/core/python/resolver.js';
import { parseUvLock } from '../../src/core/python/uv-lock.js';
import type { PythonRequirementInput } from '../../src/core/python/input-types.js';
import type { PythonResolutionMode } from '../../src/core/python/resolution-policy.js';

function metadata(name: string, version: string, requiresDist: string[] = []): PythonCoreMetadata {
  return {
    metadataVersion: '2.4',
    name,
    projectUrls: [],
    providesExtra: [],
    requiresDist,
    version,
  };
}

function wheel(name: string, version: string, suffix = 'py3-none-any'): PythonIndexFile {
  const filename = `${name.replace(/-/g, '_')}-${version}-${suffix}.whl`;
  return {
    filename,
    hashes: { sha256: 'aa'.repeat(32) },
    url: `https://files.test/${filename}`,
  };
}

class FakeIndex implements PythonIndexClient {
  readonly sourceIndex = 'https://index.test/simple';
  readonly #metadata = new Map<string, PythonCoreMetadata>();
  readonly #projects = new Map<string, PythonProjectIndex>();

  add(
    name: string,
    version: string,
    requiresDist: string[] = [],
    file = wheel(name, version)
  ): void {
    const project = this.#projects.get(name) ?? { apiVersion: '1.0', files: [], name };
    project.files.push(file);
    this.#projects.set(name, project);
    this.#metadata.set(file.url, metadata(name, version, requiresDist));
  }

  getMetadata(file: PythonIndexFile, cache: PythonMetadataCache): Promise<PythonMetadataResult> {
    void cache;
    const value = this.#metadata.get(file.url);
    return value
      ? Promise.resolve({ metadata: value, source: 'core-metadata' })
      : Promise.reject(new Error(`missing metadata for ${file.url}`));
  }

  getProject(name: string): Promise<PythonProjectIndex> {
    const project = this.#projects.get(name);
    return project
      ? Promise.resolve(project)
      : Promise.reject(new Error(`project not found: ${name}`));
  }
}

function requirement(
  raw: string,
  options: {
    constraint?: boolean;
    hash?: string;
    pythonResolutionMode?: PythonResolutionMode;
    sourcePath?: string;
  } = {}
): PythonRequirementInput {
  const parsed = parseRequirement(raw);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return {
    constraint: options.constraint === true,
    hashes: options.hash ? [{ algorithm: 'sha256', digest: options.hash }] : [],
    line: 1,
    ...(options.pythonResolutionMode ? { pythonResolutionMode: options.pythonResolutionMode } : {}),
    requiredBy: 'root',
    requirement: parsed.requirement,
    sourcePath: options.sourcePath ?? 'requirements.txt',
  };
}

const environments = [
  {
    arch: 'x86_64' as const,
    manylinux: 'manylinux_2_17',
    name: 'linux',
    os: 'linux' as const,
    pythonVersion: '3.11.9',
  },
  {
    arch: 'x86_64' as const,
    name: 'windows',
    os: 'windows' as const,
    pythonVersion: '3.12.4',
  },
];

describe('resolvePython', () => {
  it('rejects unlocked requirements by default with lock-first remediation', async () => {
    const index = new FakeIndex();
    index.add('app', '1.0');

    const result = await resolvePython({
      cache: new PythonMetadataCache(),
      environments: [environments[0]!],
      index,
      requirements: [requirement('app==1.0')],
    });

    expect(result.artifacts).toEqual([]);
    expect(result.approximate).toBe(false);
    expect(result.errors[0]?.reason).toContain('add uv.lock/pylock.toml');
    expect(result.errors[0]?.reason).toContain('--allow-approximate-python');
  });

  it('does not re-resolve requirements covered by a lockfile in the same directory', async () => {
    const lock = parseUvLock('version = 1\nrevision = 3\npackage = []', 'services/api/uv.lock');

    const result = await resolvePython({
      cache: new PythonMetadataCache(),
      environments: [environments[0]!],
      index: new FakeIndex(),
      lockfiles: [lock],
      requirements: [requirement('app==1.0', { sourcePath: 'services/api/requirements.txt' })],
    });

    expect(result).toMatchObject({ approximate: false, artifacts: [], errors: [] });
  });

  it('does not let an unrelated lockfile hide an explicit PyPI target', async () => {
    const lock = parseUvLock('version = 1\nrevision = 3\npackage = []', 'uv.lock');
    const result = await resolvePython({
      cache: new PythonMetadataCache(),
      environments: [environments[0]!],
      index: new FakeIndex(),
      lockfiles: [lock],
      requirements: [requirement('app==1.0', { sourcePath: 'workspace-targets' })],
    });

    expect(result.errors[0]?.reason).toContain('workspace-targets');
  });

  it('uses target overrides before the workspace default', async () => {
    const index = new FakeIndex();
    index.add('approximate-target', '1.0');
    index.add('locked-target', '1.0');

    const result = await resolvePython({
      cache: new PythonMetadataCache(),
      defaultResolutionMode: 'approximate',
      environments: [environments[0]!],
      index,
      requirements: [
        requirement('approximate-target==1.0'),
        requirement('locked-target==1.0', {
          pythonResolutionMode: 'locked-only',
          sourcePath: 'git-sources/example.test/acme/locked/requirements.txt',
        }),
      ],
    });

    expect(result.artifacts.map((artifact) => artifact.name)).toEqual(['approximate-target']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      name: 'locked-target',
      raw: 'locked-target==1.0',
    });
  });

  it('allows a target to opt into approximate resolution under a locked workspace default', async () => {
    const index = new FakeIndex();
    index.add('target-only', '1.0');

    const result = await resolvePython({
      cache: new PythonMetadataCache(),
      defaultResolutionMode: 'locked-only',
      environments: [environments[0]!],
      index,
      requirements: [
        requirement('target-only==1.0', {
          pythonResolutionMode: 'approximate',
          sourcePath: 'workspace-targets',
        }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.approximate).toBe(true);
  });

  it('uses the run-wide CLI override before target and workspace modes', async () => {
    const index = new FakeIndex();
    index.add('locked-target', '1.0');

    const result = await resolvePython({
      allowApproximate: true,
      cache: new PythonMetadataCache(),
      defaultResolutionMode: 'locked-only',
      environments: [environments[0]!],
      index,
      requirements: [
        requirement('locked-target==1.0', {
          pythonResolutionMode: 'locked-only',
        }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.approximate).toBe(true);
  });

  it('resolves each environment independently with constraints, markers, and extras', async () => {
    const index = new FakeIndex();
    index.add('app', '1.0', ['child>=1']);
    index.add('app', '2.0', [
      'child>=1',
      'colorama; sys_platform == "win32"',
      'speed-dep; extra == "speed"',
    ]);
    index.add('child', '1.5');
    index.add('child', '2.0');
    index.add('colorama', '0.4.6');
    index.add('speed-dep', '3.0');

    const result = await resolvePython({
      allowApproximate: true,
      cache: new PythonMetadataCache(),
      environments,
      index,
      requirements: [requirement('app[speed]>=1'), requirement('child<2', { constraint: true })],
    });

    expect(result.errors).toEqual([]);
    expect(result.approximate).toBe(true);
    const ids = result.artifacts.map(
      (artifact) => `${artifact.environment}:${artifact.name}@${artifact.version}`
    );
    expect(ids).toEqual([
      'linux:app@2.0',
      'linux:child@1.5',
      'linux:speed-dep@3.0',
      'windows:app@2.0',
      'windows:child@1.5',
      'windows:colorama@0.4.6',
      'windows:speed-dep@3.0',
    ]);
  });

  it('resolves independent approximate packages concurrently and shares project lookups', async () => {
    const index = new FakeIndex();
    index.add('first', '1.0');
    index.add('second', '1.0');
    const originalGetProject = index.getProject.bind(index);
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    index.getProject = async (name: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) {
        release();
      }
      await bothStarted;
      active -= 1;
      return await originalGetProject(name);
    };

    const result = await resolvePython({
      allowApproximate: true,
      cache: new PythonMetadataCache(),
      concurrency: 2,
      environments,
      index,
      requirements: [requirement('first==1.0'), requirement('second==1.0')],
    });

    expect(maxActive).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.artifacts).toHaveLength(4);
  });

  it('reports packages without compatible wheels', async () => {
    const index = new FakeIndex();
    index.add('native', '1.0', [], wheel('native', '1.0', 'cp311-cp311-win_amd64'));
    const result = await resolvePython({
      allowApproximate: true,
      cache: new PythonMetadataCache(),
      environments: [environments[0]!],
      index,
      requirements: [requirement('native==1.0')],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ environment: 'linux', name: 'native' });
    expect(result.errors[0]?.reason).toContain('No compatible published wheel');
  });

  it('only selects a wheel admitted by requirement hashes', async () => {
    const index = new FakeIndex();
    index.add('hashed', '1.0');
    const matching = await resolvePython({
      allowApproximate: true,
      cache: new PythonMetadataCache(),
      environments: [environments[0]!],
      index,
      requirements: [requirement('hashed==1.0', { hash: 'aa'.repeat(32) })],
    });
    const rejected = await resolvePython({
      allowApproximate: true,
      cache: new PythonMetadataCache(),
      environments: [environments[0]!],
      index,
      requirements: [requirement('hashed==1.0', { hash: 'bb'.repeat(32) })],
    });

    expect(matching.errors).toEqual([]);
    expect(matching.artifacts).toHaveLength(1);
    expect(rejected.artifacts).toEqual([]);
    expect(rejected.errors[0]?.reason).toContain('No compatible published wheel');
  });

  it('traverses uv production, extra, and development lock edges without re-resolving versions', async () => {
    const lock = parseUvLock(`
version = 1
revision = 3
[[package]]
name = "app"
version = "0.1.0"
source = { virtual = "." }
dependencies = [{ name = "requests", extra = ["socks"] }]
[package.dev-dependencies]
dev = [{ name = "pytest" }]

[[package]]
name = "requests"
version = "2.32.3"
source = { registry = "https://pypi.org/simple" }
wheels = [{ url = "https://files.test/requests-2.32.3-py3-none-any.whl", hash = "sha256:${'aa'.repeat(32)}" }]
[package.optional-dependencies]
socks = [{ name = "pysocks" }]
unused = [{ name = "unused" }]

[[package]]
name = "pysocks"
version = "1.7.1"
source = { registry = "https://pypi.org/simple" }
wheels = [{ url = "https://files.test/pysocks-1.7.1-py3-none-any.whl", hash = "sha256:${'cc'.repeat(32)}" }]

[[package]]
name = "unused"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }
wheels = [{ url = "https://files.test/unused-1.0.0-py3-none-any.whl", hash = "sha256:${'dd'.repeat(32)}" }]

[[package]]
name = "pytest"
version = "8.3.1"
source = { registry = "https://pypi.org/simple" }
wheels = [{ url = "https://files.test/pytest-8.3.1-py3-none-any.whl", hash = "sha256:${'bb'.repeat(32)}" }]
`);
    const result = await resolvePython({
      cache: new PythonMetadataCache(),
      environments: [environments[0]!],
      includeDev: true,
      index: new FakeIndex(),
      lockfiles: [lock],
    });
    expect(result.errors).toEqual([]);
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      'requests',
      'pytest',
      'pysocks',
    ]);
    expect(result.artifacts.every((artifact) => !artifact.approximate)).toBe(true);
  });
});
