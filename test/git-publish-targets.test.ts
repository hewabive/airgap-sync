import { describe, expect, it } from 'vitest';
import { createGitConfigRewriteRules, resolveGitPublishTargets } from '../src/index.js';
import type { GitSource, GitSourcesManifest } from '../src/types.js';

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

function source(host: string, owner: string, repo: string): GitSource {
  return {
    host,
    id: `${host}/${owner}/${repo}`,
    localMirrorPath: `git-mirrors/${host}/${owner}/${repo}.git`,
    owner,
    repo,
    requirements: [],
    sourceUrl: `https://${host}/${owner}/${repo}.git`,
  };
}

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
    expect(rules).not.toContainEqual(expect.objectContaining({ insteadOf: 'https://github.com/' }));
  });

  it('rejects different preserved sources that publish to the same owner and repository', () => {
    expect(() =>
      resolveGitPublishTargets({
        manifest: {
          ...manifest,
          sources: [source('github.com', 'acme', 'app'), source('gitlab.example', 'acme', 'app')],
        },
        strategy: 'preserve',
      })
    ).toThrow(
      'Git publish target collision: acme/app: github.com/acme/app and gitlab.example/acme/app'
    );
  });

  it('rejects host-only source moves for remapped owner strategies too', () => {
    expect(() =>
      resolveGitPublishTargets({
        authenticatedUser: 'maxim',
        manifest: {
          ...manifest,
          sources: [source('github.com', 'acme', 'app'), source('gitlab.example', 'acme', 'app')],
        },
        strategy: 'authenticated-user',
      })
    ).toThrow(
      'Git publish target collision: maxim/acme--app: github.com/acme/app and gitlab.example/acme/app'
    );
  });

  it('allows equal repository names under different preserved owners', () => {
    const resolved = resolveGitPublishTargets({
      manifest: {
        ...manifest,
        sources: [source('github.com', 'first', 'app'), source('gitlab.example', 'second', 'app')],
      },
      strategy: 'preserve',
    });

    expect(resolved.sources).toMatchObject([
      { publishOwner: 'first', publishRepo: 'app' },
      { publishOwner: 'second', publishRepo: 'app' },
    ]);
  });

  it('treats destination owner and repository names as case-insensitive', () => {
    expect(() =>
      resolveGitPublishTargets({
        manifest: {
          ...manifest,
          sources: [source('github.com', 'Acme', 'App'), source('gitlab.example', 'acme', 'app')],
        },
        strategy: 'preserve',
      })
    ).toThrow('Git publish target collision');
  });
});
