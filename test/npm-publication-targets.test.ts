import { describe, expect, it } from 'vitest';
import {
  giteaNpmRegistryUrl,
  isGiteaNpmRegistryUrl,
  normalizeNpmRegistryTarget,
  resolveNpmRegistryTarget,
} from '../src/index.js';

describe('npm registry publication targets', () => {
  it('normalizes an explicit Verdaccio target', () => {
    expect(
      normalizeNpmRegistryTarget({ type: 'verdaccio', url: ' http://verdaccio.local:4873/ ' })
    ).toEqual({ type: 'verdaccio', url: 'http://verdaccio.local:4873' });
  });

  it('builds a Gitea npm endpoint from the shared base URL and owner', () => {
    const resolved = resolveNpmRegistryTarget(
      {
        owner: {
          kind: 'organization',
          name: 'airgap packages',
          strategy: 'fixed-owner',
        },
        type: 'gitea',
        visibility: 'private',
      },
      { giteaBaseUrl: 'http://gitea.local/' }
    );

    expect(resolved).toEqual({
      owner: { kind: 'organization', name: 'airgap packages' },
      ownerRequirement: {
        kind: 'organization',
        name: 'airgap packages',
        purposes: ['npm'],
        visibility: 'private',
      },
      registryUrl: 'http://gitea.local/api/packages/airgap%20packages/npm/',
      type: 'gitea',
      visibility: 'private',
    });
  });

  it('resolves an authenticated-user owner and recognizes Gitea endpoints', () => {
    const resolved = resolveNpmRegistryTarget(
      {
        owner: { strategy: 'authenticated-user' },
        type: 'gitea',
        visibility: 'public',
      },
      { authenticatedUser: 'publisher', giteaBaseUrl: 'https://gitea.example' }
    );
    expect(resolved.registryUrl).toBe(giteaNpmRegistryUrl('https://gitea.example', 'publisher'));
    expect(isGiteaNpmRegistryUrl(resolved.registryUrl)).toBe(true);
    expect(isGiteaNpmRegistryUrl('http://verdaccio.local:4873')).toBe(false);
  });

  it('requires the shared Gitea URL', () => {
    expect(() =>
      resolveNpmRegistryTarget(
        {
          owner: { kind: 'organization', name: 'packages', strategy: 'fixed-owner' },
          type: 'gitea',
          visibility: 'public',
        },
        {}
      )
    ).toThrow('Gitea npm registry requires giteaUrl');
  });
});
