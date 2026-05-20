import { describe, expect, it } from 'vitest';
import { parseRootSpecs } from '../src/core/specs.js';

describe('parseRootSpecs', () => {
  it('treats a bare package name as the latest tag', () => {
    expect(parseRootSpecs(['react']).requirements).toEqual([
      {
        name: 'react',
        raw: 'react',
        requiredBy: 'root',
        specifier: 'latest',
        type: 'tag',
      },
    ]);
  });

  it('parses registry tags, ranges, versions, and scoped packages', () => {
    expect(
      parseRootSpecs(['react@latest', '@types/node@^22', 'typescript@5.9.3']).requirements
    ).toEqual([
      {
        name: 'react',
        raw: 'react@latest',
        requiredBy: 'root',
        specifier: 'latest',
        type: 'tag',
      },
      {
        name: '@types/node',
        raw: '@types/node@^22',
        requiredBy: 'root',
        specifier: '^22',
        type: 'range',
      },
      {
        name: 'typescript',
        raw: 'typescript@5.9.3',
        requiredBy: 'root',
        specifier: '5.9.3',
        type: 'version',
      },
    ]);
  });

  it('keeps alias information while resolving the real package target', () => {
    expect(parseRootSpecs(['my-react@npm:react@latest']).requirements).toEqual([
      {
        alias: 'my-react',
        aliasTargetType: 'tag',
        name: 'react',
        raw: 'my-react@npm:react@latest',
        requiredBy: 'root',
        specifier: 'latest',
        type: 'alias',
      },
    ]);
  });

  it('reports unsupported non-registry specs instead of throwing', () => {
    const result = parseRootSpecs([
      'git+https://github.com/user/project.git',
      'file:../local-package',
    ]);

    expect(result.requirements).toEqual([]);
    expect(result.unsupported).toEqual([
      {
        raw: 'git+https://github.com/user/project.git',
        reason: 'Package name could not be inferred from spec',
        type: 'git',
      },
      {
        raw: 'file:../local-package',
        reason: 'Package name could not be inferred from spec',
        type: 'directory',
      },
    ]);
  });

  it('ignores empty specs', () => {
    expect(parseRootSpecs(['', '   '])).toEqual({
      requirements: [],
      unsupported: [],
    });
  });
});
