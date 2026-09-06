import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import {
  classifyUvResolutionFailure,
  createUvCompileInvocation,
  UvApplicationResolver,
  uvPlatformTarget,
  type UvResolveRequest,
} from '../../src/core/python/uv-adapter.js';

let tempDir: string;

function request(overrides: Partial<UvResolveRequest> = {}): UvResolveRequest {
  return {
    cacheDir: path.join(tempDir, 'cache'),
    platformFamilyId: 'linux-glibc-x86_64',
    pythonMinor: '3.11',
    requirement: 'demo-app==1.0.0',
    sourceIndex: 'https://pypi.org/simple/',
    uvPath: '/tools/uv',
    workDir: path.join(tempDir, 'work'),
    ...overrides,
  };
}

describe('uv application resolver adapter', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-uv-adapter-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('constructs isolated, wheels-only target-platform invocations', () => {
    const invocation = createUvCompileInvocation(
      request({
        cutoff: '2026-07-27T00:00:00Z',
        glibc: '2.35',
      }),
      '/work/requirements.in',
      '/work/pylock.toml',
      { PATH: '/bin' }
    );

    expect(invocation.args).toEqual([
      'pip',
      'compile',
      '/work/requirements.in',
      '--python-version',
      '3.11',
      '--python-platform',
      'x86_64-manylinux_2_35',
      '--only-binary=:all:',
      '--format',
      'pylock.toml',
      '--no-header',
      '--quiet',
      '--index-url',
      'https://pypi.org/simple/',
      '--exclude-newer',
      '2026-07-27T00:00:00Z',
      '--output-file',
      '/work/pylock.toml',
    ]);
    expect(invocation.env).toMatchObject({
      PATH: '/bin',
      UV_NO_CONFIG: '1',
      UV_NO_PROGRESS: '1',
      UV_NO_SYSTEM_CONFIG: '1',
    });
    expect(uvPlatformTarget('windows-x86_64')).toBe('x86_64-pc-windows-msvc');
  });

  it('uses the requested prerelease policy and removes ambient source overrides', () => {
    const invocation = createUvCompileInvocation(
      { ...request(), prerelease: 'allow' },
      '/in',
      '/out',
      {
        UV_INDEX: 'https://unconfigured.test/',
        UV_FIND_LINKS: '/other-wheels',
        UV_PRERELEASE: 'disallow',
        PATH: '/bin',
      }
    );
    expect(invocation.args).toContain('--prerelease');
    expect(invocation.args[invocation.args.indexOf('--prerelease') + 1]).toBe('allow');
    expect(invocation.env.UV_INDEX).toBeUndefined();
    expect(invocation.env.UV_FIND_LINKS).toBeUndefined();
    expect(invocation.env.UV_PRERELEASE).toBeUndefined();
    expect(invocation.env.PATH).toBe('/bin');
  });

  it('maps uv failures to stable planner error kinds', () => {
    expect(classifyUvResolutionFailure('No solution found when resolving')).toBe('no-solution');
    expect(
      classifyUvResolutionFailure('source distributions are disabled and no wheels are available')
    ).toBe('no-wheel');
    expect(classifyUvResolutionFailure('process crashed')).toBe('tool-failure');
  });

  it('parses machine-readable pylock evidence', async () => {
    let requirementsInput = '';
    const resolver = new UvApplicationResolver(async (invocation) => {
      if (invocation.args[0] === '--version') {
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'uv 0.11.16\n',
        };
      }
      requirementsInput = await fs.readFile(invocation.args[2]!, 'utf8');
      const outputPath = invocation.args.at(-1)!;
      await fs.writeFile(
        outputPath,
        [
          'lock-version = "1.0"',
          'created-by = "uv 0.11.16"',
          'requires-python = ">=3.11,<3.12"',
          '',
          '[[packages]]',
          'name = "demo-app"',
          'version = "1.0.0"',
          'wheels = [',
          '  { name = "demo_app-1.0.0-py3-none-any.whl", url = "https://example.test/demo.whl", hashes = { sha256 = "' +
            'a'.repeat(64) +
            '" } },',
          ']',
          '',
        ].join('\n')
      );
      return {
        exitCode: 0,
        stderr: '',
        stdout: '',
      };
    });

    const evidence = await resolver.resolve(
      request({
        additionalRequirements: ['native-helper==2.0.0'],
      })
    );

    expect(evidence.platformTarget).toBe('x86_64-manylinux_2_17');
    expect(evidence.lock.packages[0]).toMatchObject({
      name: 'demo-app',
      version: '1.0.0',
    });
    expect(evidence.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(requirementsInput).toBe('demo-app==1.0.0\nnative-helper==2.0.0\n');
  });

  it('preserves a no-solution error without parsing human text upstream', async () => {
    const resolver = new UvApplicationResolver((invocation) =>
      Promise.resolve(
        invocation.args[0] === '--version'
          ? {
              exitCode: 0,
              stderr: '',
              stdout: 'uv 0.11.16\n',
            }
          : {
              exitCode: 1,
              stderr: 'No solution found when resolving dependencies',
              stdout: '',
            }
      )
    );

    await expect(resolver.resolve(request())).rejects.toMatchObject({
      kind: 'no-solution',
    });
  });

  it('rejects an executable that does not match the reviewed pin', async () => {
    const resolver = new UvApplicationResolver(() =>
      Promise.resolve({
        exitCode: 0,
        stderr: '',
        stdout: 'uv 9.9.9\n',
      })
    );

    await expect(resolver.resolve(request())).rejects.toThrow('Expected uv 0.11.16');
  });
});
