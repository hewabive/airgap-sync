import { describe, expect, it } from 'vitest';
import { parsePnpmLockRequirementsFromContent } from '../src/core/pnpm-lock.js';

describe('parsePnpmLockRequirementsFromContent', () => {
  it('extracts exact package versions from pnpm lockfile package keys', () => {
    const result = parsePnpmLockRequirementsFromContent(
      `
lockfileVersion: '9.0'

packages:
  '@scope/demo@1.2.3':
    resolution: {integrity: sha512-demo}
  plain@2.0.0:
    resolution: {integrity: sha512-plain}

snapshots:
  '@scope/demo@1.2.3(peer@4.0.0)': {}
  linked@link:packages/linked: {}
`,
      'pnpm-lock:pnpm-lock.yaml'
    );

    expect(result).toEqual({
      gitRequirements: [],
      requirements: [
        {
          name: '@scope/demo',
          raw: '@scope/demo@1.2.3',
          requiredBy: 'pnpm-lock:pnpm-lock.yaml',
          specifier: '1.2.3',
          type: 'version',
        },
        {
          name: 'plain',
          raw: 'plain@2.0.0',
          requiredBy: 'pnpm-lock:pnpm-lock.yaml',
          specifier: '2.0.0',
          type: 'version',
        },
      ],
      unsupported: [],
    });
  });
});
