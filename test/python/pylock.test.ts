import { describe, expect, it } from 'vitest';
import { parsePylock } from '../../src/core/python/pylock.js';

describe('parsePylock', () => {
  it('parses standardized lock metadata and wheel records', () => {
    const lock = parsePylock(
      `
lock-version = "1.0"
created-by = "uv"
requires-python = ">=3.12"
environments = ["sys_platform == 'linux'", "sys_platform == 'win32'"]
extras = ["speed"]
dependency-groups = ["test"]
default-groups = ["default"]

[[packages]]
name = "attrs"
version = "25.1.0"
requires-python = ">=3.8"
marker = "'speed' in extras or 'default' in dependency_groups"
dependencies = [{ name = "typing-extensions", version = "4.12.2" }]
index = "https://pypi.org/simple/"

[[packages.wheels]]
name = "attrs-25.1.0-py3-none-any.whl"
url = "https://files.example/attrs-25.1.0-py3-none-any.whl"
size = 42
hashes = { sha256 = "${'bb'.repeat(32)}" }
`,
      'pylock.prod.toml'
    );

    expect(lock).toMatchObject({
      createdBy: 'uv',
      defaultGroups: ['default'],
      dependencyGroups: ['test'],
      extras: ['speed'],
      format: 'pylock',
      requiresPython: '>=3.12',
      sourcePath: 'pylock.prod.toml',
    });
    expect(lock.packages[0]).toMatchObject({
      dependencies: [{ name: 'typing-extensions', version: '4.12.2' }],
      marker: "'speed' in extras or 'default' in dependency_groups",
      name: 'attrs',
      source: 'https://pypi.org/simple/',
      sourceKind: 'registry',
      wheels: [
        {
          filename: 'attrs-25.1.0-py3-none-any.whl',
          hashes: { sha256: 'bb'.repeat(32) },
          size: 42,
        },
      ],
    });
  });

  it('rejects unsupported versions and preserves source-only registry packages', () => {
    expect(() => parsePylock('lock-version = "2.0"\ncreated-by = "x"\npackages = []')).toThrow(
      /unsupported/
    );
    expect(
      parsePylock(
        'lock-version = "1.0"\ncreated-by = "x"\n[[packages]]\nname = "demo"\nversion = "1"\n[packages.sdist]\nurl = "https://files/demo-1.tar.gz"\nhashes = {sha256 = "aa"}'
      ).packages[0]
    ).toMatchObject({ name: 'demo', sourceKind: 'registry', wheels: [] });
  });
});
