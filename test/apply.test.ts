import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBundle, type GiteaClient } from '../src/index.js';
import * as fs from '../src/core/fs.js';
import type { BundleManifest, DistTagsManifest, GitSourcesManifest } from '../src/types.js';

let bundleDir: string;

const manifest: BundleManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-21T00:00:00.000Z',
  sourceRegistry: 'https://registry.npmjs.org',
  packages: [
    {
      file: 'packages/demo-1.0.0.tgz',
      name: 'demo',
      resolvedFrom: [
        {
          raw: 'demo@latest',
          requiredBy: 'root',
          specifier: 'latest',
          type: 'tag',
        },
      ],
      tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
      version: '1.0.0',
    },
  ],
};

const distTags: DistTagsManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-21T00:00:00.000Z',
  requirements: [
    {
      name: 'demo',
      requiredBy: 'root',
      tag: 'latest',
      version: '1.0.0',
    },
  ],
  sourceRegistry: 'https://registry.npmjs.org',
  tags: {
    demo: {
      latest: '1.0.0',
    },
  },
};

const gitSources: GitSourcesManifest = {
  schemaVersion: 1,
  createdAt: '2026-05-21T00:00:00.000Z',
  skipped: [],
  sources: [
    {
      host: 'github.com',
      id: 'github.com/acme/app',
      localMirrorPath: 'git-mirrors/github.com/acme/app.git',
      owner: 'acme',
      repo: 'app',
      requirements: [],
      sourceUrl: 'https://github.com/acme/app.git',
    },
  ],
};

const noopClient: GiteaClient = {
  createOrganization: () => Promise.resolve(),
  createRepository: () => Promise.resolve(),
  organizationExists: () => Promise.resolve(false),
  repositoryExists: () => Promise.resolve(false),
};

describe('applyBundle', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-apply-'));
    await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), manifest, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'dist-tags.json'), distTags, { spaces: 2 });
    await fs.ensureDir(path.join(bundleDir, 'packages'));
    await fs.writeFile(path.join(bundleDir, 'packages/demo-1.0.0.tgz'), '');
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('plans npm publish and tolerates bundles without Git sources', async () => {
    const report = await applyBundle({
      bundleDir,
      dryRun: true,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      giteaClient: noopClient,
      registryUrl: 'http://verdaccio.local:4873',
    });

    expect(report).toMatchObject({
      dryRun: true,
      gitApply: {
        planned: 0,
        totalRepositories: 0,
      },
      gitea: {
        planned: 0,
        totalRepositories: 0,
      },
      publish: {
        dryRun: true,
        published: 1,
        restoredTags: 1,
      },
      succeeded: true,
    });
    expect(await fs.pathExists(path.join(bundleDir, 'apply-dry-run-report.json'))).toBe(true);
    expect(await fs.pathExists(path.join(bundleDir, 'publish-dry-run-report.json'))).toBe(true);
  });

  it('plans Gitea provisioning, mirror push, and optional Git config', async () => {
    await fs.writeJson(path.join(bundleDir, 'git-sources.json'), gitSources, { spaces: 2 });

    const report = await applyBundle({
      bundleDir,
      configureGitGlobal: true,
      dryRun: true,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      giteaClient: noopClient,
      registryUrl: 'http://verdaccio.local:4873',
    });

    expect(report.gitApply).toMatchObject({
      planned: 1,
      totalRepositories: 1,
    });
    expect(report.gitea).toMatchObject({
      organizationPlanned: 1,
      planned: 1,
      totalRepositories: 1,
    });
    expect(report.gitConfig).toMatchObject({
      planned: 3,
      totalRules: 3,
    });
    expect(report.gitApply.gitConfigRewriteRules).toEqual([
      {
        command: 'git config --global --add url."http://gitea.local/".insteadOf "git@github.com:"',
        insteadOf: 'git@github.com:',
        targetUrl: 'http://gitea.local/',
      },
      {
        command:
          'git config --global --add url."http://gitea.local/".insteadOf "https://github.com/"',
        insteadOf: 'https://github.com/',
        targetUrl: 'http://gitea.local/',
      },
      {
        command:
          'git config --global --add url."http://gitea.local/".insteadOf "ssh://git@github.com/"',
        insteadOf: 'ssh://git@github.com/',
        targetUrl: 'http://gitea.local/',
      },
    ]);
    expect(await fs.pathExists(path.join(bundleDir, 'git-config-report.json'))).toBe(true);
  });
});
