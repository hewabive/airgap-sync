import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverPythonInputs } from '../../src/core/python/discovery.js';

const fixtureRoot = path.resolve('test/fixtures/python-project');

describe('Python project fixtures', () => {
  it('discovers production and development requirements plus uv and pylock graphs', async () => {
    const withoutDev = await discoverPythonInputs(fixtureRoot);
    const withDev = await discoverPythonInputs(fixtureRoot, { includeDev: true });

    expect(withoutDev.lockfiles.map((lock) => lock.format)).toEqual(['pylock', 'uv']);
    expect(withoutDev.requirements.map((input) => input.requirement.normalizedName)).toEqual([
      'idna',
      'colorama',
    ]);
    expect(withDev.requirements.map((input) => input.requirement.normalizedName)).toEqual([
      'idna',
      'colorama',
      'pytest',
    ]);
    expect(withDev.lockfiles.find((lock) => lock.format === 'uv')?.packages).toHaveLength(3);
    expect(withDev.lockfiles.find((lock) => lock.format === 'pylock')?.packages[0]).toMatchObject({
      name: 'urllib3',
      version: '2.2.3',
    });
    expect(withDev.unsupported).toEqual([]);
  });
});
