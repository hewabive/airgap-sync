import { describe, expect, it } from 'vitest';
import { parseRequirementsText } from '../../src/core/python/requirements-txt.js';

describe('parseRequirementsText', () => {
  it('parses requirements, hashes, continuations, includes, and constraints', async () => {
    const files: Record<string, string> = {
      'deps/constraints.txt': 'urllib3==2.2.2',
      'deps/dev.txt': 'pytest>=8\n-r nested/more.txt',
      'deps/nested/more.txt': 'coverage==7.6',
    };
    const result = await parseRequirementsText(
      [
        'requests[socks]==2.32.3 \\',
        `  --hash=sha256:${'aa'.repeat(32)} # pinned root`,
        '-r deps/dev.txt',
        '-c deps/constraints.txt',
      ].join('\n'),
      {
        readIncluded(filePath) {
          const content = files[filePath];
          return content === undefined
            ? Promise.reject(new Error('missing'))
            : Promise.resolve(content);
        },
        sourcePath: 'requirements.txt',
      }
    );

    expect(result.files).toEqual([
      'deps/constraints.txt',
      'deps/dev.txt',
      'deps/nested/more.txt',
      'requirements.txt',
    ]);
    expect(result.requirements).toHaveLength(4);
    expect(result.requirements[0]).toMatchObject({
      constraint: false,
      hashes: [{ algorithm: 'sha256', digest: 'aa'.repeat(32) }],
      requirement: { extras: ['socks'], name: 'requests', specifier: '==2.32.3' },
    });
    expect(result.requirements.find((item) => item.requirement.name === 'urllib3')).toMatchObject({
      constraint: true,
    });
    expect(result.unsupported).toEqual([]);
  });

  it('reports unsupported options, URLs, malformed lines, and missing includes', async () => {
    const result = await parseRequirementsText(
      [
        '--index-url https://example.test/simple',
        '-e ../local',
        'demo @ https://example.test/demo.whl',
        'not a valid requirement ???',
        '-r missing.txt',
      ].join('\n'),
      {
        readIncluded: () => Promise.reject(new Error('not found')),
        sourcePath: 'requirements.txt',
      }
    );
    expect(result.requirements).toEqual([]);
    expect(result.unsupported.map((item) => item.type)).toEqual([
      'option',
      'option',
      'url',
      'requirement',
      'include',
    ]);
  });

  it('breaks recursive include cycles', async () => {
    const result = await parseRequirementsText('-r requirements.txt\ndemo==1', {
      readIncluded: () => Promise.resolve('-r requirements.txt'),
      sourcePath: 'requirements.txt',
    });
    expect(result.requirements.map((item) => item.requirement.name)).toEqual(['demo']);
  });

  it('reports includes that escape the repository root', async () => {
    const result = await parseRequirementsText('-r ../outside.txt', {
      sourcePath: 'requirements.txt',
    });
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]?.type).toBe('include');
    expect(result.unsupported[0]?.reason).toContain('escapes');
  });
});
