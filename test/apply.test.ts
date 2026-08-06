import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBundle,
  defaultPythonPublicationProfile,
  downloadCpythonDistributionBundle,
  type ApplyProgressEvent,
  type GiteaClient,
} from '../src/index.js';
import * as fs from '../src/core/fs.js';
import type { BundleManifest, DistTagsManifest, GitSourcesManifest } from '../src/types.js';
import type { GitCommandInvocation } from '../src/core/git-fetch.js';
import type { PythonApplicationBundleIndex } from '../src/core/python/application-bundle.js';
import { normalizePlatformCoveragePolicy } from '../src/core/python/coverage-policy.js';
import { createPythonEnvironmentPlan } from '../src/core/python/environment-plan.js';

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

async function writePythonApplicationBundle(): Promise<void> {
  const policy = normalizePlatformCoveragePolicy({
    id: 'windows',
    platforms: ['windows-x86_64'],
  });
  const plan = createPythonEnvironmentPlan({
    application: { name: 'demo-python', version: '1.0.0' },
    coverage: { digest: 'a'.repeat(64), families: [], policy },
    createdAt: '2026-07-28T00:00:00.000Z',
    intent: {
      application: { extras: [], features: {}, name: 'demo-python' },
      coverage: { policyId: 'windows' },
      python: { policy: 'auto' },
      source: { type: 'pypi' },
      updatePolicy: 'manual',
    },
    platforms: [],
    resolver: { engine: 'uv', policyVersion: 1, version: '0.11.16' },
    runtimeContract: { platforms: [], uvVersions: ['0.11.16'] },
    schemaVersion: 2,
    wheels: [],
  });
  const directory = path.join(bundleDir, 'python/applications/demo-python--windows');
  await fs.writeJson(path.join(directory, 'environment-plan.json'), plan, { spaces: 2 });
  await fs.writeJson(path.join(directory, 'plan-diff.json'), { schemaVersion: 1 }, { spaces: 2 });
  await fs.writeJson(
    path.join(directory, 'prerequisites.json'),
    { schemaVersion: 1 },
    { spaces: 2 }
  );
  const index: PythonApplicationBundleIndex = {
    applications: [
      {
        application: plan.application,
        artifactIds: [],
        branchSizes: [],
        features: {},
        locks: [],
        planDiffPath: 'python/applications/demo-python--windows/plan-diff.json',
        planId: plan.planId,
        planPath: 'python/applications/demo-python--windows/environment-plan.json',
        prerequisiteReportPath: 'python/applications/demo-python--windows/prerequisites.json',
        targetId: 'demo-python--windows',
      },
    ],
    artifacts: [],
    createdAt: '2026-07-28T00:00:00.000Z',
    schemaVersion: 3,
    summary: { applications: 1, artifacts: 0, totalBytes: 0 },
  };
  await fs.writeJson(path.join(bundleDir, 'python/application-index.json'), index, { spaces: 2 });
}

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

  it('plans additive CPython distribution publication through the generic package owner', async () => {
    const content = Buffer.from('cpython archive');
    const filename =
      'cpython-3.12.13+20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz';
    await downloadCpythonDistributionBundle({
      bundleDir,
      candidates: [
        {
          filename,
          platformFamilyId: 'linux-glibc-x86_64',
          provider: 'python-build-standalone',
          providerBuild: '20260805',
          providerPublishedAt: '2026-08-05T00:00:00.000Z',
          pythonVersion: '3.12.13',
          sha256: createHash('sha256').update(content).digest('hex'),
          size: content.length,
          sourceUrl: `https://github.example/${filename}`,
        },
      ],
      fetch: () =>
        Promise.resolve(
          new Response(content, { headers: { 'content-length': String(content.length) } })
        ),
      generatedAt: '2026-08-06T00:00:00.000Z',
      targets: [
        {
          builds: { windowDays: 30 },
          patches: { latest: 1 },
          platforms: ['linux-glibc-x86_64'],
          provider: 'python-build-standalone',
          series: { from: '3.12', major: 3, through: 'latest-stable' },
          type: 'cpython-distributions',
        },
      ],
    });

    const report = await applyBundle({
      bundleDir,
      dryRun: true,
      generatedAt: '2026-08-06T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      giteaClient: noopClient,
      registryUrl: 'http://verdaccio.local:4873',
    });

    expect(report.cpythonDistributions).toMatchObject({
      enabled: true,
      errors: [],
      owner: 'airgap-packages',
      planned: 1,
    });
    expect(report.gitea.organizations).toContainEqual(
      expect.objectContaining({ owner: 'airgap-packages', status: 'planned' })
    );
    expect(report.succeeded).toBe(true);
  });

  it('plans Python publishing when a Python seed manifest is present', async () => {
    await fs.writeJson(
      path.join(bundleDir, 'python-seed-manifest.json'),
      {
        schemaVersion: 1,
        createdAt: '2026-07-10T00:00:00.000Z',
        packages: [
          {
            files: [
              {
                coreMetadata: {
                  metadataVersion: '2.4',
                  name: 'demo-python',
                  projectUrls: [],
                  providesExtra: [],
                  requiresDist: [],
                  version: '1.0',
                },
                environments: ['prod'],
                file: 'python-packages/demo_python-1.0-py3-none-any.whl',
                filename: 'demo_python-1.0-py3-none-any.whl',
                kind: 'wheel',
                sha256: 'aa'.repeat(32),
                sourceHashes: { sha256: 'aa'.repeat(32) },
                url: 'https://files.example/demo_python-1.0-py3-none-any.whl',
              },
            ],
            name: 'demo-python',
            resolvedFrom: [],
            version: '1.0',
          },
        ],
        roots: ['demo-python==1.0'],
        sourceIndex: 'https://pypi.org/simple/',
        targetEnvironments: [],
      },
      { spaces: 2 }
    );

    const progress: ApplyProgressEvent[] = [];
    const report = await applyBundle({
      bundleDir,
      dryRun: true,
      generatedAt: '2026-07-10T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      giteaClient: noopClient,
      onProgress: (event) => progress.push(event),
      pythonOwner: 'public',
      registryUrl: 'http://verdaccio.local:4873',
    });

    expect(report.python).toMatchObject({
      indexUrl: 'http://gitea.local/api/packages/public/pypi/simple',
      planned: 1,
    });
    expect(report.gitea.organizations).toContainEqual({
      owner: 'public',
      status: 'planned',
    });
    expect(report.succeeded).toBe(true);
    expect(await fs.pathExists(path.join(bundleDir, 'python-publish-dry-run-report.json'))).toBe(
      true
    );
    expect(progress).toContainEqual({
      current: 0,
      phase: 'python-publish',
      status: 'start',
      total: 1,
    });
    expect(progress).toContainEqual({
      current: 1,
      detail: 'planned demo_python-1.0-py3-none-any.whl',
      phase: 'python-publish',
      status: 'progress',
      total: 1,
    });
    expect(progress).toContainEqual({
      current: 1,
      phase: 'python-publish',
      status: 'done',
      total: 1,
    });
  });

  it('resolves and materializes Python application publication during apply', async () => {
    await writePythonApplicationBundle();

    const report = await applyBundle({
      bundleDir,
      dryRun: true,
      generatedAt: '2026-07-28T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      giteaClient: noopClient,
      pythonPublicationProfile: {
        ...defaultPythonPublicationProfile(),
        publishEvidence: true,
      },
      registryUrl: 'http://verdaccio.local:4873',
    });

    expect(report.gitea.organizations).toContainEqual({
      owner: 'airgap-packages',
      status: 'planned',
    });
    expect(report.pythonApplications).toMatchObject({
      errors: [],
      planned: 6,
    });
    expect(report.pythonApplications?.publicationId).toMatch(/^[a-f0-9]{64}$/u);
    expect(await fs.pathExists(path.join(bundleDir, 'python/publications'))).toBe(false);
  });

  it('blocks Python uploads when the package organization cannot be provisioned', async () => {
    await fs.writeJson(
      path.join(bundleDir, 'seed-manifest.json'),
      { ...manifest, packages: [] },
      {
        spaces: 2,
      }
    );
    await fs.writeJson(
      path.join(bundleDir, 'dist-tags.json'),
      { ...distTags, requirements: [], tags: {} },
      { spaces: 2 }
    );
    await writePythonApplicationBundle();

    const report = await applyBundle({
      bundleDir,
      generatedAt: '2026-07-28T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      giteaClient: {
        ...noopClient,
        createOrganization: () => Promise.reject(new Error('organization create failed')),
      },
      pythonPublicationProfile: {
        ...defaultPythonPublicationProfile(),
        publishEvidence: true,
      },
      registryUrl: 'http://verdaccio.local:4873',
    });

    expect(report.gitea.organizationErrors).toEqual([
      expect.objectContaining({
        error: 'organization create failed',
        owner: 'airgap-packages',
      }),
    ]);
    expect(report.pythonApplications?.errors).toEqual([
      expect.objectContaining({
        error: 'Gitea owner airgap-packages could not be provisioned',
      }),
    ]);
    expect(await fs.pathExists(path.join(bundleDir, 'python/publications'))).toBe(false);
    expect(report.succeeded).toBe(false);
  });

  it('plans Gitea provisioning, mirror push, and optional Git config', async () => {
    await fs.writeJson(path.join(bundleDir, 'git-sources.json'), gitSources, { spaces: 2 });
    const progress: ApplyProgressEvent[] = [];

    const report = await applyBundle({
      bundleDir,
      configureGitGlobal: true,
      dryRun: true,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://gitea.local',
      giteaClient: noopClient,
      onProgress: (event) => progress.push(event),
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
    expect(progress).toContainEqual({
      current: 0,
      phase: 'git-apply',
      status: 'start',
      total: 1,
    });
    expect(progress).toContainEqual({
      current: 1,
      detail: 'planned github.com/acme/app',
      phase: 'git-apply',
      status: 'progress',
      total: 1,
    });
    expect(progress).toContainEqual({
      current: 1,
      phase: 'git-apply',
      status: 'done',
      total: 1,
    });
  });

  it('passes Gitea token auth to mirror push', async () => {
    const emptyManifest: BundleManifest = {
      ...manifest,
      packages: [],
    };
    const emptyDistTags: DistTagsManifest = {
      ...distTags,
      requirements: [],
      tags: {},
    };
    const mirrorPath = path.join(bundleDir, 'git-mirrors/github.com/acme/app.git');
    const gitCalls: GitCommandInvocation[] = [];
    const authHeader = `Authorization: Basic ${Buffer.from('maxim:secret').toString('base64')}`;
    await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), emptyManifest, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'dist-tags.json'), emptyDistTags, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'git-sources.json'), gitSources, { spaces: 2 });
    await fs.ensureDir(mirrorPath);

    const report = await applyBundle({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      gitAuth: {
        password: 'secret',
        username: 'maxim',
      },
      giteaBaseUrl: 'http://gitea.local',
      giteaClient: noopClient,
      registryUrl: 'http://verdaccio.local:4873',
      runGitCommand(invocation) {
        gitCalls.push(invocation);
        return Promise.resolve(undefined);
      },
    });

    expect(report.gitApply).toMatchObject({
      pushed: 1,
      totalRepositories: 1,
    });
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0]).toMatchObject({
      args: [
        '-c',
        `safe.directory=${mirrorPath}`,
        '-c',
        'credential.helper=',
        '-c',
        `http.extraHeader=${authHeader}`,
        '-C',
        mirrorPath,
        'push',
        '--prune',
        'http://gitea.local/acme/app.git',
        '+refs/heads/*:refs/heads/*',
        '+refs/tags/*:refs/tags/*',
      ],
      env: {
        GCM_INTERACTIVE: 'never',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  });

  it('can skip Gitea provisioning when target Git repositories already exist', async () => {
    const emptyManifest: BundleManifest = {
      ...manifest,
      packages: [],
    };
    const emptyDistTags: DistTagsManifest = {
      ...distTags,
      requirements: [],
      tags: {},
    };
    const mirrorPath = path.join(bundleDir, 'git-mirrors/github.com/acme/app.git');
    let repositoryExistsCalls = 0;
    await fs.writeJson(path.join(bundleDir, 'seed-manifest.json'), emptyManifest, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'dist-tags.json'), emptyDistTags, { spaces: 2 });
    await fs.writeJson(path.join(bundleDir, 'git-sources.json'), gitSources, { spaces: 2 });
    await fs.ensureDir(mirrorPath);

    const report = await applyBundle({
      bundleDir,
      generatedAt: '2026-05-21T00:00:00.000Z',
      giteaBaseUrl: 'http://git.local',
      giteaClient: {
        ...noopClient,
        repositoryExists() {
          repositoryExistsCalls++;
          return Promise.resolve(false);
        },
      },
      registryUrl: 'http://verdaccio.local:4873',
      runGitCommand() {
        return Promise.resolve(undefined);
      },
      skipGitProvision: true,
    });

    expect(repositoryExistsCalls).toBe(0);
    expect(report.gitea).toMatchObject({
      created: 0,
      errors: [],
      exists: 1,
      giteaBaseUrl: 'http://git.local',
      totalRepositories: 1,
    });
    expect(report.gitApply).toMatchObject({
      errors: [],
      pushed: 1,
      totalRepositories: 1,
    });
    expect(report.succeeded).toBe(true);
  });
});
