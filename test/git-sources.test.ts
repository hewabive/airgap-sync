import { describe, expect, it } from 'vitest';
import { createGitSourcesManifest } from '../src/core/git-sources.js';
import type { GitRequirement } from '../src/types.js';

const antvSetupRequirement: GitRequirement = {
  committish: '7cb42f57561c321ecb09b4552802ae0ac55b3a7a',
  hosted: {
    domain: 'github.com',
    project: 'G2',
    type: 'github',
    user: 'antvis',
  },
  name: '@antv/setup',
  raw: '@antv/setup@github:antvis/G2#7cb42f57561c321ecb09b4552802ae0ac55b3a7a',
  rawSpec: 'github:antvis/G2#7cb42f57561c321ecb09b4552802ae0ac55b3a7a',
  requiredBy: 'echarts-for-react@3.0.7',
};

describe('createGitSourcesManifest', () => {
  it('groups hosted git requirements into portable source identities', () => {
    const manifest = createGitSourcesManifest(
      [
        antvSetupRequirement,
        {
          ...antvSetupRequirement,
          requiredBy: 'size-sensor@1.0.4',
        },
      ],
      {
        createdAt: '2026-05-21T00:00:00.000Z',
      }
    );

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      createdAt: '2026-05-21T00:00:00.000Z',
      skipped: [],
      sources: [
        {
          committish: '7cb42f57561c321ecb09b4552802ae0ac55b3a7a',
          host: 'github.com',
          id: 'github.com/antvis/G2',
          localMirrorPath: 'git-mirrors/github.com/antvis/G2.git',
          owner: 'antvis',
          repo: 'G2',
          sourceUrl: 'https://github.com/antvis/G2.git',
        },
      ],
    });
    expect(manifest.sources[0]?.requirements).toHaveLength(2);
  });

  it('deduplicates repeated requirements for the same package edge', () => {
    const manifest = createGitSourcesManifest([antvSetupRequirement, antvSetupRequirement], {
      createdAt: '2026-05-21T00:00:00.000Z',
    });

    expect(manifest.sources[0]?.requirements).toEqual([antvSetupRequirement]);
  });

  it('infers source identity from a cloneable URL when hosted metadata is absent', () => {
    const requirement: GitRequirement = {
      fetchSpec: 'https://git.example.local/team/project.git',
      raw: 'demo@git+https://git.example.local/team/project.git#main',
      rawSpec: 'git+https://git.example.local/team/project.git#main',
      requiredBy: 'root',
    };

    expect(
      createGitSourcesManifest([requirement], {
        createdAt: '2026-05-21T00:00:00.000Z',
      }).sources
    ).toEqual([
      {
        fetchSpec: 'https://git.example.local/team/project.git',
        host: 'git.example.local',
        id: 'git.example.local/team/project',
        localMirrorPath: 'git-mirrors/git.example.local/team/project.git',
        owner: 'team',
        repo: 'project',
        requirements: [requirement],
        sourceUrl: 'https://git.example.local/team/project.git',
      },
    ]);
  });

  it('reports requirements that do not expose a cloneable source identity', () => {
    const requirement: GitRequirement = {
      raw: 'demo@git+file:../demo',
      rawSpec: 'git+file:../demo',
      requiredBy: 'root',
    };

    const manifest = createGitSourcesManifest([requirement], {
      createdAt: '2026-05-21T00:00:00.000Z',
    });

    expect(manifest.sources).toEqual([]);
    expect(manifest.skipped).toEqual([
      {
        reason: 'Unable to infer a cloneable source identity',
        requirement,
      },
    ]);
  });
});
