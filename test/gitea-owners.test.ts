import { describe, expect, it } from 'vitest';
import { mergeGiteaOwnerRequirements, resolveGiteaOwnerTarget } from '../src/core/gitea-owners.js';

describe('resolveGiteaOwnerTarget', () => {
  it('uses the authenticated user without provisioning another principal', () => {
    expect(resolveGiteaOwnerTarget({ strategy: 'authenticated-user' }, 'publisher')).toEqual({
      kind: 'user',
      name: 'publisher',
    });
  });

  it('accepts a fixed organization owned by the authenticated actor', () => {
    expect(
      resolveGiteaOwnerTarget(
        {
          kind: 'organization',
          name: 'airgap-packages',
          strategy: 'fixed-owner',
        },
        undefined
      )
    ).toEqual({
      kind: 'organization',
      name: 'airgap-packages',
    });
  });

  it('rejects a fixed user that differs from the authenticated user', () => {
    expect(() =>
      resolveGiteaOwnerTarget(
        {
          kind: 'user',
          name: 'other-user',
          strategy: 'fixed-owner',
        },
        'publisher'
      )
    ).toThrow('Fixed Gitea user other-user does not match authenticated user publisher');
  });
});

describe('mergeGiteaOwnerRequirements', () => {
  it('deduplicates owners and combines purposes deterministically', () => {
    expect(
      mergeGiteaOwnerRequirements([
        {
          kind: 'organization',
          name: 'airgap-packages',
          purposes: ['generic'],
          visibility: 'public',
        },
        {
          kind: 'organization',
          name: 'airgap-packages',
          purposes: ['pypi', 'git'],
          visibility: 'private',
        },
      ])
    ).toEqual([
      {
        kind: 'organization',
        name: 'airgap-packages',
        purposes: ['git', 'pypi', 'generic'],
        visibility: 'public',
      },
    ]);
  });

  it('rejects a namespace required as both a user and organization', () => {
    expect(() =>
      mergeGiteaOwnerRequirements([
        {
          kind: 'user',
          name: 'packages',
          purposes: ['pypi'],
          visibility: 'public',
        },
        {
          kind: 'organization',
          name: 'packages',
          purposes: ['generic'],
          visibility: 'public',
        },
      ])
    ).toThrow('Gitea owner packages is required as both user and organization');
  });
});
