import { describe, expect, it } from 'vitest';
import { parseDependencySpec, parseRootSpecs } from '../src/core/specs.js';

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
        requiredBy: 'root',
        type: 'git',
      },
      {
        raw: 'file:../local-package',
        reason: 'Package name could not be inferred from spec',
        requiredBy: 'root',
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

describe('parseDependencySpec', () => {
  it('parses dependency specs with a non-root requiredBy value', () => {
    expect(parseDependencySpec('is-number', '^7.0.0', 'kind-of@6.0.3')).toEqual({
      name: 'is-number',
      raw: 'is-number@^7.0.0',
      requiredBy: 'kind-of@6.0.3',
      specifier: '^7.0.0',
      type: 'range',
    });
  });

  it('parses dependency tag specs', () => {
    expect(parseDependencySpec('demo', 'latest', 'root-package@1.0.0')).toEqual({
      name: 'demo',
      raw: 'demo@latest',
      requiredBy: 'root-package@1.0.0',
      specifier: 'latest',
      type: 'tag',
    });
  });

  it('normalizes npm exact version specs with a leading equals sign', () => {
    expect(parseDependencySpec('demo', '=1.2.3', 'root-package@1.0.0')).toEqual({
      name: 'demo',
      raw: 'demo@=1.2.3',
      requiredBy: 'root-package@1.0.0',
      specifier: '1.2.3',
      type: 'version',
    });
  });

  it('reports unsupported dependency specs', () => {
    expect(parseDependencySpec('local-package', 'file:../local-package', 'root@1.0.0')).toEqual({
      raw: 'local-package@file:../local-package',
      reason: 'Unsupported package spec type: directory',
      requiredBy: 'root@1.0.0',
      type: 'directory',
    });
  });
});
