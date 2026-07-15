import { describe, expect, it } from 'vitest';
import { parseUvLock } from '../../src/core/python/uv-lock.js';

describe('parseUvLock', () => {
  it('parses registry files, graph edges, optional dependencies, and development groups', () => {
    const lock = parseUvLock(
      `
version = 1
revision = 3
requires-python = ">=3.11"
resolution-markers = ["sys_platform == 'linux'", "sys_platform == 'win32'"]

[[package]]
name = "app"
version = "0.1.0"
source = { virtual = "." }
dependencies = [{ name = "requests", extra = ["socks"] }]
[package.dev-dependencies]
dev = [{ name = "pytest", version = "8.3.1" }]
[package.optional-dependencies]
speed = [{ name = "orjson" }]

[[package]]
name = "requests"
version = "2.32.3"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "urllib3", marker = "python_version >= '3.9'" }]
wheels = [
  { url = "https://files.example/requests-2.32.3-py3-none-any.whl", hash = "sha256:${'aa'.repeat(32)}", size = 123 }
]
`,
      'services/app/uv.lock'
    );

    expect(lock).toMatchObject({
      environments: ["sys_platform == 'linux'", "sys_platform == 'win32'"],
      format: 'uv',
      requiresPython: '>=3.11',
      sourcePath: 'services/app/uv.lock',
      version: '1.3',
    });
    expect(lock.packages[0]).toMatchObject({
      dependencies: [{ extras: ['socks'], name: 'requests' }],
      devDependencies: { dev: [{ name: 'pytest', version: '8.3.1' }] },
      name: 'app',
      optionalDependencies: { speed: [{ name: 'orjson' }] },
      sourceKind: 'virtual',
    });
    expect(lock.packages[1]).toMatchObject({
      dependencies: [{ marker: "python_version >= '3.9'", name: 'urllib3' }],
      name: 'requests',
      sourceKind: 'registry',
      wheels: [
        {
          filename: 'requests-2.32.3-py3-none-any.whl',
          hashes: { sha256: 'aa'.repeat(32) },
          size: 123,
        },
      ],
    });
  });

  it('rejects future revisions and malformed registry packages', () => {
    expect(() => parseUvLock('version = 1\nrevision = 99\npackage = []')).toThrow(/revision/);
    expect(() =>
      parseUvLock('version = 1\n[[package]]\nname = "demo"\nsource = { registry = "x" }')
    ).toThrow(/missing a version/);
  });
});
