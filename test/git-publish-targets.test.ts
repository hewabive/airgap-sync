import { describe, expect, it } from 'vitest';
import { createGitConfigRewriteRules, resolveGitPublishTargets } from '../src/index.js';
import type { GitSourcesManifest } from '../src/types.js';

const manifest: GitSourcesManifest = {
  schemaVersion: 1,
  createdAt: '2026-07-15T00:00:00.000Z',
  sources: [
    {
      host: 'github.com',
      id: 'github.com/vllm-project/vllm',
      localMirrorPath: 'git-mirrors/github.com/vllm-project/vllm.git',
      owner: 'vllm-project',
      repo: 'vllm',
      requirements: [],
      sourceUrl: 'https://github.com/vllm-project/vllm.git',
    },
  ],
  skipped: [],
};

describe('resolveGitPublishTargets', () => {
  it('maps repositories to the authenticated user without changing source identity', () => {
    const resolved = resolveGitPublishTargets({
      authenticatedUser: 'maxim',
      manifest,
      strategy: 'authenticated-user',
    });

    expect(resolved.sources[0]).toMatchObject({
      id: 'github.com/vllm-project/vllm',
      localMirrorPath: 'git-mirrors/github.com/vllm-project/vllm.git',
      owner: 'vllm-project',
      publishOwner: 'maxim',
      publishOwnerKind: 'user',
      publishRepo: 'vllm-project--vllm',
      repo: 'vllm',
    });
  });

  it('requires a fixed user owner to match the authenticated user', () => {
    expect(() =>
      resolveGitPublishTargets({
        authenticatedUser: 'maxim',
        fixedOwner: 'someone-else',
        fixedOwnerKind: 'user',
        manifest,
        strategy: 'fixed-owner',
      })
    ).toThrow('does not match authenticated user maxim');
  });

  it('uses repository-specific rewrites for remapped owners', () => {
    const resolved = resolveGitPublishTargets({
      authenticatedUser: 'maxim',
      manifest,
      strategy: 'authenticated-user',
    });
    const rules = createGitConfigRewriteRules(resolved, 'http://gitea.local');

    expect(rules).toContainEqual({
      command:
        'git config --global --add url."http://gitea.local/maxim/vllm-project--vllm.git".insteadOf "https://github.com/vllm-project/vllm.git"',
      insteadOf: 'https://github.com/vllm-project/vllm.git',
      targetUrl: 'http://gitea.local/maxim/vllm-project--vllm.git',
    });
    expect(rules).not.toContainEqual(
      expect.objectContaining({ insteadOf: 'https://github.com/' })
    );
  });
});
