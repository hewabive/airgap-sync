import { describe, expect, it } from 'vitest';
import {
  defaultPythonPublicationProfile,
  normalizePythonPublicationProfile,
  resolvePythonPublicationProfile,
} from '../../src/core/python/publication-targets.js';

describe('Python publication targets', () => {
  it('uses one managed public organization by default', () => {
    const profile = defaultPythonPublicationProfile();

    expect(resolvePythonPublicationProfile(profile, 'admin')).toEqual({
      genericOwner: {
        kind: 'organization',
        name: 'airgap-packages',
      },
      ownerRequirements: [
        {
          kind: 'organization',
          name: 'airgap-packages',
          purposes: ['pypi', 'generic'],
          visibility: 'public',
        },
      ],
      pypiOwner: {
        kind: 'organization',
        name: 'airgap-packages',
      },
      visibility: 'public',
    });
  });

  it('supports separate PyPI and Generic organizations with the same token', () => {
    const profile = normalizePythonPublicationProfile({
      genericOwner: {
        kind: 'organization',
        name: 'python-artifacts',
        strategy: 'fixed-owner',
      },
      owner: {
        kind: 'organization',
        name: 'python-packages',
        strategy: 'fixed-owner',
      },
      visibility: 'public',
    });

    expect(resolvePythonPublicationProfile(profile, 'admin')).toMatchObject({
      genericOwner: {
        kind: 'organization',
        name: 'python-artifacts',
      },
      ownerRequirements: [
        {
          name: 'python-artifacts',
          purposes: ['generic'],
        },
        {
          name: 'python-packages',
          purposes: ['pypi'],
        },
      ],
      pypiOwner: {
        kind: 'organization',
        name: 'python-packages',
      },
    });
  });

  it('resolves authenticated-user targets without creating another identity', () => {
    const profile = normalizePythonPublicationProfile({
      owner: {
        strategy: 'authenticated-user',
      },
      visibility: 'private',
    });

    expect(resolvePythonPublicationProfile(profile, 'maxim')).toMatchObject({
      genericOwner: {
        kind: 'user',
        name: 'maxim',
      },
      ownerRequirements: [
        {
          kind: 'user',
          name: 'maxim',
          purposes: ['pypi', 'generic'],
          visibility: 'private',
        },
      ],
      pypiOwner: {
        kind: 'user',
        name: 'maxim',
      },
    });
  });

  it('rejects a fixed user that differs from the authenticated user', () => {
    const profile = normalizePythonPublicationProfile({
      owner: {
        kind: 'user',
        name: 'packages',
        strategy: 'fixed-owner',
      },
      visibility: 'public',
    });

    expect(() => resolvePythonPublicationProfile(profile, 'admin')).toThrow(
      'Fixed Gitea user packages does not match authenticated user admin'
    );
  });
});
