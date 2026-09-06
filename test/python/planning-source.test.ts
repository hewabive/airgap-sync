import { describe, expect, it } from 'vitest';
import { HttpStatusError } from '../../src/core/retry.js';
import { createPythonPlanningSource } from '../../src/core/python/planning-source.js';
import { normalizePythonResolutionPolicy } from '../../src/core/python/source-policy.js';
import type { PythonProjectIndex } from '../../src/core/python/index-client.js';
import type { UvResolveRequest } from '../../src/core/python/uv-adapter.js';

const request: UvResolveRequest = {
  cacheDir: '/cache',
  platformFamilyId: 'linux-glibc-x86_64',
  pythonMinor: '3.12',
  requirement: 'demo==1',
  sourceIndex: 'https://pypi.test/simple/',
  uvPath: '/uv',
  workDir: '/work',
  cutoff: '2026-01-01T00:00:00Z',
  prerelease: 'allow',
};

describe('Python planning source', () => {
  it('shares a frozen routed view with uv, including explicit handling of unknown dates', async () => {
    const calls: string[] = [];
    const source = await createPythonPlanningSource({
      sourceIndex: request.sourceIndex,
      cutoff: request.cutoff!,
      resolution: {
        packageIndexes: [
          { indexUrl: 'https://vendor.test/', packages: ['demo'], missingUploadTime: 'allow' },
        ],
      },
      createClient: (url) => ({
        sourceIndex: url,
        getMetadata: () => Promise.reject(new Error('unused')),
        getProject: (name) => {
          calls.push(`${url}${name}`);
          return Promise.resolve({
            apiVersion: '1.0',
            name,
            files: [
              {
                filename: `${name}-1-py3-none-any.whl`,
                url: `${url}one.whl`,
                hashes: { sha256: 'a'.repeat(64) },
              },
              {
                filename: `${name}-2-py3-none-any.whl`,
                url: `${url}two.whl`,
                hashes: {},
                uploadTime: '2027-01-01T00:00:00Z',
              },
              {
                filename: `${name}-3-py3-none-any.whl`,
                url: `${url}three.whl`,
                hashes: {},
                yanked: true,
              },
            ],
          });
        },
      }),
      resolver: {
        resolve: async (actual) => {
          expect(actual.cutoff).toBeUndefined();
          expect(actual.prerelease).toBe('allow');
          const response = await fetch(`${actual.sourceIndex}demo/`);
          const project = (await response.json()) as PythonProjectIndex;
          expect(project.files).toHaveLength(1);
          expect(project.files[0]?.url).toBe('https://vendor.test/one.whl');
          throw new Error('fixture completed');
        },
      },
    });
    try {
      const first = await source.index.getProject('Demo');
      await expect(source.resolver.resolve(request)).rejects.toThrow('fixture completed');
      expect(await source.index.getProject('demo')).toBe(first);
      expect((await source.index.getProject('other')).files).toEqual([]);
      expect(calls).toEqual(['https://vendor.test/demo', 'https://pypi.test/simple/other']);
      expect(source.snapshot().projects[0]?.indexUrl).toBe('https://vendor.test/');
    } finally {
      await source.close();
    }
  });

  it('does not fall back from an assigned index and propagates infrastructure failures', async () => {
    const calls: string[] = [];
    const source = await createPythonPlanningSource({
      sourceIndex: request.sourceIndex,
      cutoff: request.cutoff!,
      resolution: { packageIndexes: [{ indexUrl: 'https://vendor.test/', packages: ['demo'] }] },
      createClient: (url) => ({
        sourceIndex: url,
        getMetadata: () => Promise.reject(new Error('unused')),
        getProject: () => {
          calls.push(url);
          return Promise.reject(new Error('vendor unavailable'));
        },
      }),
      resolver: {
        resolve: async (actual) => {
          expect((await fetch(`${actual.sourceIndex}demo/`)).status).toBe(502);
          throw new Error('generic uv failure');
        },
      },
    });
    try {
      await expect(source.resolver.resolve(request)).rejects.toThrow('vendor unavailable');
      expect(calls).toEqual(['https://vendor.test/']);
    } finally {
      await source.close();
    }
  });

  it('limits prerelease candidates to named packages and keeps missing assigned projects missing', async () => {
    const source = await createPythonPlanningSource({
      sourceIndex: request.sourceIndex,
      cutoff: request.cutoff!,
      resolution: {
        prereleasePackages: ['allowed'],
        packageIndexes: [
          {
            indexUrl: 'https://vendor.test/',
            packages: ['allowed', 'stable', 'missing'],
            missingUploadTime: 'allow',
          },
        ],
      },
      createClient: (url) => ({
        sourceIndex: url,
        getMetadata: () => Promise.reject(new Error('unused')),
        getProject: (name) => {
          if (name === 'missing') return Promise.reject(new HttpStatusError('missing', 404));
          return Promise.resolve({
            name,
            apiVersion: '1.0',
            files: [
              { filename: `${name}-1.0rc1-py3-none-any.whl`, hashes: {}, url: `${url}preview.whl` },
              { filename: `${name}-0.9-py3-none-any.whl`, hashes: {}, url: `${url}stable.whl` },
            ],
          });
        },
      }),
      resolver: {
        resolve: async (actual) => {
          expect(actual.prerelease).toBe('allow');
          expect((await fetch(`${actual.sourceIndex}missing/`)).status).toBe(404);
          throw new Error('missing fixture');
        },
      },
    });
    try {
      expect((await source.index.getProject('allowed')).files).toHaveLength(2);
      expect((await source.index.getProject('stable')).files).toHaveLength(1);
      await expect(source.resolver.resolve(request)).rejects.toThrow('missing fixture');
    } finally {
      await source.close();
    }
  });

  it('validates explicit source ownership and rejects normalized duplicate assignments', () => {
    expect(
      normalizePythonResolutionPolicy({
        packageIndexes: [{ indexUrl: 'https://vendor.test', packages: ['CUDA_Tile'] }],
      })?.packageIndexes?.[0]?.packages
    ).toEqual(['cuda-tile']);
    expect(() =>
      normalizePythonResolutionPolicy({
        packageIndexes: [{ indexUrl: 'https://vendor.test', packages: ['CUDA_Tile', 'cuda-tile'] }],
      })
    ).toThrow('Duplicate');
    expect(() =>
      normalizePythonResolutionPolicy({
        packageIndexes: [{ indexUrl: 'https://user:secret@vendor.test', packages: ['demo'] }],
      })
    ).toThrow('credentials');
    expect(() => normalizePythonResolutionPolicy({ prerelease: 'yes' })).toThrow('prerelease');
    expect(() =>
      normalizePythonResolutionPolicy({ prerelease: 'allow', prereleasePackages: ['demo'] })
    ).toThrow('not both');
  });
});
