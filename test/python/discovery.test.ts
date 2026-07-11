import { describe, expect, it } from 'vitest';
import { discoverPythonInputsFromPaths } from '../../src/core/python/discovery.js';

const files: Record<string, string> = {
  'requirements.txt': '-r requirements/base.txt\nrequests==2.32.3',
  'requirements/base.txt': 'certifi==2026.1.1',
  'requirements-dev.txt': 'pytest==8.3.1',
  'services/app/pyproject.toml': '[project]\nname = "app"',
  'services/app/uv.lock': 'version = 1\nrevision = 3\npackage = []',
  'tools/pyproject.toml': '[project]\nname = "tool"',
};

function readFile(filePath: string): Promise<string> {
  const content = files[filePath];
  return content === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(content);
}

describe('discoverPythonInputsFromPaths', () => {
  it('discovers production requirements, includes, locks, and unlocked pyprojects', async () => {
    const result = await discoverPythonInputsFromPaths(Object.keys(files), readFile);
    expect(result.requirementPaths).toEqual(['requirements.txt', 'requirements/base.txt']);
    expect(result.requirements.map((item) => item.requirement.name)).toEqual([
      'certifi',
      'requests',
    ]);
    expect(result.lockfilePaths).toEqual(['services/app/uv.lock']);
    expect(result.pyprojectWithoutLock).toEqual(['tools/pyproject.toml']);
    expect(result.unsupported).toEqual([
      expect.objectContaining({
        sourcePath: 'tools/pyproject.toml',
        type: 'pyproject-without-lock',
      }),
    ]);
  });

  it('includes standalone development requirement files when requested', async () => {
    const result = await discoverPythonInputsFromPaths(Object.keys(files), readFile, {
      includeDev: true,
    });
    expect(result.requirements.map((item) => item.requirement.name)).toContain('pytest');
    expect(result.requirementPaths).toContain('requirements-dev.txt');
  });
});
