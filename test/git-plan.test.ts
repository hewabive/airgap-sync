import { describe, expect, it } from 'vitest';
import { createGitMirrorPlan } from '../src/core/git-plan.js';
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

describe('createGitMirrorPlan', () => {
  it('groups hosted git requirements into one Gitea mirror repository', () => {
    const plan = createGitMirrorPlan(
      [
        antvSetupRequirement,
        {
          ...antvSetupRequirement,
          requiredBy: 'size-sensor@1.0.4',
        },
      ],
      {
        createdAt: '2026-05-20T00:00:00.000Z',
        giteaBaseUrl: 'http://gitea.local/',
        owner: '/npm-mirrors/',
      }
    );

    expect(plan).toMatchObject({
      schemaVersion: 1,
      createdAt: '2026-05-20T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      owner: 'npm-mirrors',
      skipped: [],
      repositories: [
        {
          id: 'github.com/antvis/G2',
          repository: 'github.com-antvis-g2',
          sourceUrl: 'https://github.com/antvis/G2.git',
          targetUrl: 'http://gitea.local/npm-mirrors/github.com-antvis-g2.git',
        },
      ],
    });
    expect(plan.repositories[0]?.requirements).toHaveLength(2);
    expect(plan.repositories[0]?.insteadOf).toContain('https://github.com/antvis/G2.git');
    expect(plan.repositories[0]?.insteadOf).toContain('git@github.com:antvis/G2.git');
  });

  it('deduplicates repeated requirements for the same package edge', () => {
    const plan = createGitMirrorPlan([antvSetupRequirement, antvSetupRequirement], {
      createdAt: '2026-05-20T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      owner: 'npm-mirrors',
    });

    expect(plan.repositories[0]?.requirements).toEqual([antvSetupRequirement]);
  });

  it('reports requirements that do not expose a cloneable source URL', () => {
    const requirement: GitRequirement = {
      raw: 'demo@git+file:../demo',
      rawSpec: 'git+file:../demo',
      requiredBy: 'root',
    };

    const plan = createGitMirrorPlan([requirement], {
      createdAt: '2026-05-20T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      owner: 'npm-mirrors',
    });

    expect(plan.repositories).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        reason: 'Unable to infer a cloneable source URL',
        requirement,
      },
    ]);
  });
});
