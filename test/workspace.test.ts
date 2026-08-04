import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import {
  addWorkspaceTarget,
  clearWorkspaceGiteaToken,
  createWorkspaceGitSources,
  createWorkspacePythonRequirements,
  createWorkspacePythonRootWheels,
  createWorkspacePythonRuntimeArtifacts,
  createWorkspaceSnapshot,
  initWorkspace,
  migrateWorkspaceConfig,
  previewWorkspaceConfigMigration,
  previewWorkspaceMigration,
  readWorkspaceConfig,
  readWorkspaceSecrets,
  removeWorkspaceTarget,
  resolveWorkspacePythonApplication,
  saveWorkspaceGiteaToken,
  selectWorkspaceTargets,
  setWorkspaceTargetPythonResolutionMode,
  workspaceConfigPythonPublicationBackupFileName,
  workspaceConfigPythonPublicationProfileBackupFileName,
  workspaceConfigV1BackupFileName,
  workspaceLegacyPythonSettings,
  workspaceSecretsFileName,
  writeWorkspaceConfig,
} from '../src/core/workspace.js';

let tempDir: string;

describe('workspace config', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-workspace-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('initializes a portable workspace config and directories', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });

    expect(config).toEqual({
      defaults: {
        download: {
          includeDev: true,
          includePeer: true,
          latestPolicy: 'bundled',
          prune: true,
          rangeResolutionPolicy: 'reuse-stable',
          tagResolutionPolicy: 'reuse-stable',
        },
        publish: {
          configureGitGlobal: false,
          provisionGit: true,
          publicRepositories: true,
        },
        verifyInstall: {
          ignoreScripts: true,
        },
      },
      coveragePolicies: [
        {
          id: 'desktop-x64',
          platforms: ['linux-glibc-x86_64'],
          version: 1,
          wheelStrategy: 'all-compatible',
        },
      ],
      gitOwnerStrategy: 'preserve',
      output: './airgap-bundle',
      python: {
        artifactTransfer: {
          cpython: true,
          uv: false,
        },
        planner: {
          engine: 'uv',
          version: '0.11.16',
        },
        publication: {
          owner: {
            kind: 'organization',
            name: 'airgap-packages',
            strategy: 'fixed-owner',
          },
          visibility: 'public',
        },
        sourceIndex: 'https://pypi.org/simple/',
      },
      schemaVersion: 2,
      sourceRegistry: 'https://registry.npmjs.org',
      targets: [],
    });
    expect(await fs.pathExists(path.join(tempDir, 'airgap-sync.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, 'airgap-bundle'))).toBe(true);
    expect(
      await fs.pathExists(path.join(tempDir, '.airgap-sync/recipes/ktransformers-0.6.1.post1.json'))
    ).toBe(true);
  });

  it('adds, lists, deduplicates, and removes targets', async () => {
    await initWorkspace({ workspaceDir: tempDir });

    await addWorkspaceTarget(tempDir, {
      branch: 'main',
      type: 'git',
      url: 'https://github.com/acme/app.git',
    });
    const duplicate = await addWorkspaceTarget(tempDir, {
      branch: 'main',
      type: 'git',
      url: 'https://github.com/acme/app.git',
    });
    await addWorkspaceTarget(tempDir, {
      spec: 'eslint@latest',
      type: 'npm',
    });

    expect(duplicate.added).toBe(false);
    expect((await readWorkspaceConfig(tempDir)).targets).toEqual([
      {
        branch: 'main',
        type: 'git',
        url: 'https://github.com/acme/app.git',
      },
      {
        spec: 'eslint@latest',
        type: 'npm',
      },
    ]);

    const removed = await removeWorkspaceTarget(tempDir, 1);
    expect(removed.removed).toEqual({
      branch: 'main',
      type: 'git',
      url: 'https://github.com/acme/app.git',
    });
    expect((await readWorkspaceConfig(tempDir)).targets).toEqual([
      {
        spec: 'eslint@latest',
        type: 'npm',
      },
    ]);
  });

  it('adds a Python application with automatic runtime and default broad coverage', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    const coverage = config.coveragePolicies?.[0]?.id;
    expect(coverage).toBe('desktop-x64');

    await addWorkspaceTarget(tempDir, {
      application: {
        extras: ['cuda'],
        features: {
          accelerator: 'cuda',
        },
        version: '>=0.4,<0.5',
      },
      coverage: coverage!,
      python: {
        policy: 'auto',
      },
      spec: 'KTransformers',
      type: 'python-app',
    });

    expect((await readWorkspaceConfig(tempDir)).targets).toEqual([
      {
        application: {
          extras: ['cuda'],
          features: {
            accelerator: 'cuda',
          },
          version: '>=0.4,<0.5',
        },
        coverage: 'desktop-x64',
        python: {
          policy: 'auto',
        },
        spec: 'ktransformers',
        type: 'python-app',
      },
    ]);
  });

  it('normalizes an explicit Python minor matrix for an application', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    await addWorkspaceTarget(tempDir, {
      application: {
        extras: [],
        features: {},
      },
      coverage: 'desktop-x64',
      python: {
        policy: 'selected',
        versions: ['3.12', '3.13', '3.12'],
      },
      spec: 'vllm',
      type: 'python-app',
    });

    expect((await readWorkspaceConfig(tempDir)).targets[0]).toMatchObject({
      python: {
        policy: 'selected',
        versions: ['3.12', '3.13'],
      },
    });
  });

  it('normalizes optional closed-network endpoints', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      {
        giteaUrl: ' http://gitea.local ',
        output: './airgap-bundle',
        schemaVersion: 1,
        sourceRegistry: 'https://registry.npmjs.org',
        targetRegistry: ' http://verdaccio.local:4873 ',
        targets: [],
      },
      { spaces: 2 }
    );

    expect(await readWorkspaceConfig(tempDir)).toMatchObject({
      defaults: {
        download: {
          includeDev: true,
          includePeer: true,
          latestPolicy: 'bundled',
          prune: true,
          rangeResolutionPolicy: 'reuse-stable',
          tagResolutionPolicy: 'reuse-stable',
        },
        publish: {
          configureGitGlobal: false,
          provisionGit: true,
          publicRepositories: true,
        },
        verifyInstall: {
          ignoreScripts: true,
        },
      },
      giteaUrl: 'http://gitea.local',
      targetRegistry: 'http://verdaccio.local:4873',
    });
  });

  it('normalizes Python settings and PyPI targets', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      {
        output: './airgap-bundle',
        pythonPublishOwner: ' pypi ',
        pythonSourceIndex: 'https://packages.example/simple',
        pythonTargetEnvironments: [
          {
            arch: 'x86_64',
            manylinux: 'manylinux_2_17',
            name: 'prod-linux',
            os: 'linux',
            pythonVersion: '3.11.9',
          },
        ],
        schemaVersion: 1,
        sourceRegistry: 'https://registry.npmjs.org',
        targets: [
          {
            pythonResolutionMode: 'approximate',
            spec: 'requests[socks]>=2.31',
            type: 'pypi',
          },
        ],
      },
      { spaces: 2 }
    );

    expect(await readWorkspaceConfig(tempDir)).toMatchObject({
      python: {
        legacySeed: {
          resolutionMode: 'locked-only',
          targetEnvironments: [
            {
              arch: 'x86_64',
              manylinux: 'manylinux_2_17',
              name: 'prod-linux',
              os: 'linux',
              pythonVersion: '3.11.9',
            },
          ],
        },
        publication: {
          owner: {
            kind: 'organization',
            name: 'airgap-packages',
            strategy: 'fixed-owner',
          },
          visibility: 'public',
        },
        sourceIndex: 'https://packages.example/simple',
      },
      schemaVersion: 2,
      targets: [
        {
          pythonResolutionMode: 'approximate',
          spec: 'requests[socks]>=2.31',
          type: 'pypi',
        },
      ],
    });
  });

  it('normalizes exact Python wheel targets and creates transfer inputs', async () => {
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      {
        output: './airgap-bundle',
        pythonResolutionMode: 'locked-only',
        pythonTargetEnvironments: [
          {
            arch: 'x86_64',
            manylinux: 'manylinux_2_34',
            name: 'cpu',
            os: 'linux',
            pythonVersion: '3.12.13',
          },
        ],
        schemaVersion: 1,
        sourceRegistry: 'https://registry.npmjs.org',
        targets: [
          {
            pythonResolutionMode: 'approximate',
            sha256: 'A'.repeat(64),
            type: 'python-wheel',
            url: 'https://example.test/vllm-0.24.0+cpu-cp38-abi3-manylinux_2_34_x86_64.whl',
          },
        ],
      },
      { spaces: 2 }
    );

    const config = await readWorkspaceConfig(tempDir);
    expect(config.targets[0]).toMatchObject({
      pythonResolutionMode: 'approximate',
      sha256: 'a'.repeat(64),
      type: 'python-wheel',
    });
    expect(createWorkspacePythonRootWheels(config)[0]).toMatchObject({
      pythonResolutionMode: 'approximate',
      requiredBy: 'root',
      sha256: 'a'.repeat(64),
      sourcePath: 'workspace-wheel-targets',
    });
  });

  it('normalizes portable Python runtime targets', async () => {
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      {
        output: './airgap-bundle',
        schemaVersion: 1,
        sourceRegistry: 'https://registry.npmjs.org',
        targets: [
          {
            pythonVersion: '3.12.13',
            sha256: 'b'.repeat(64),
            type: 'python-runtime',
            url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260623/cpython.tar.gz',
          },
        ],
      },
      { spaces: 2 }
    );

    const config = await readWorkspaceConfig(tempDir);
    expect(createWorkspacePythonRuntimeArtifacts(config)).toEqual([
      {
        pythonVersion: '3.12.13',
        sha256: 'b'.repeat(64),
        url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260623/cpython.tar.gz',
      },
    ]);
  });

  it('requires target environments for PyPI targets', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    await expect(
      addWorkspaceTarget(tempDir, { spec: 'requests==2.32.3', type: 'pypi' })
    ).rejects.toThrow(/pythonTargetEnvironments/);
  });

  it('creates Python requirements for configured PyPI targets', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    config.targets.push({
      pythonResolutionMode: 'approximate',
      spec: 'requests[socks]>=2.31',
      type: 'pypi',
    });
    expect(createWorkspacePythonRequirements(config)).toEqual([
      {
        constraint: false,
        hashes: [],
        line: 1,
        pythonResolutionMode: 'approximate',
        requiredBy: 'root',
        requirement: {
          extras: ['socks'],
          name: 'requests',
          normalizedName: 'requests',
          raw: 'requests[socks]>=2.31',
          specifier: '>=2.31',
        },
        sourcePath: 'workspace-targets',
      },
    ]);
  });

  it('sets and clears a target-specific Python resolution override', async () => {
    const config = await initWorkspace({ legacy: true, workspaceDir: tempDir });
    config.pythonTargetEnvironments = [
      {
        arch: 'x86_64',
        manylinux: 'manylinux_2_17',
        name: 'prod-linux',
        os: 'linux',
        pythonVersion: '3.11.9',
      },
    ];
    await fs.writeJson(path.join(tempDir, 'airgap-sync.json'), config, { spaces: 2 });
    await addWorkspaceTarget(tempDir, {
      spec: 'requests>=2.31',
      type: 'pypi',
    });

    const updated = await setWorkspaceTargetPythonResolutionMode(tempDir, 1, 'approximate');
    expect(updated.target).toMatchObject({
      pythonResolutionMode: 'approximate',
      spec: 'requests>=2.31',
      type: 'pypi',
    });
    expect((await readWorkspaceConfig(tempDir)).targets[0]).toHaveProperty(
      'pythonResolutionMode',
      'approximate'
    );

    await setWorkspaceTargetPythonResolutionMode(tempDir, 1, undefined);
    expect((await readWorkspaceConfig(tempDir)).targets[0]).not.toHaveProperty(
      'pythonResolutionMode'
    );
  });

  it('rejects Python resolution overrides for target types without Python inputs', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    config.targets.push({ spec: 'eslint@latest', type: 'npm' });
    await fs.writeJson(path.join(tempDir, 'airgap-sync.json'), config, { spaces: 2 });

    await expect(setWorkspaceTargetPythonResolutionMode(tempDir, 1, 'approximate')).rejects.toThrow(
      'npm targets do not resolve Python dependencies'
    );
  });

  it('normalizes workspace menu defaults', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      {
        defaults: {
          download: {
            includeDev: false,
            includePeer: true,
            latestPolicy: 'source',
            prune: 'ask',
            rangeResolutionPolicy: 'refresh',
            tagResolutionPolicy: 'refresh',
          },
          publish: {
            configureGitGlobal: true,
            provisionGit: 'ask',
            publicRepositories: 'ask',
          },
          verifyInstall: {
            ignoreScripts: 'ask',
          },
        },
        output: './airgap-bundle',
        schemaVersion: 1,
        sourceRegistry: 'https://registry.npmjs.org',
        targets: [],
      },
      { spaces: 2 }
    );

    expect((await readWorkspaceConfig(tempDir)).defaults).toEqual({
      download: {
        includeDev: false,
        includePeer: true,
        latestPolicy: 'source',
        prune: 'ask',
        rangeResolutionPolicy: 'refresh',
        tagResolutionPolicy: 'refresh',
      },
      publish: {
        configureGitGlobal: true,
        provisionGit: 'ask',
        publicRepositories: 'ask',
      },
      verifyInstall: {
        ignoreScripts: 'ask',
      },
    });
  });

  it('stores local secrets outside the workspace config', async () => {
    await initWorkspace({ workspaceDir: tempDir });

    expect(await readWorkspaceSecrets(tempDir)).toEqual({
      schemaVersion: 1,
    });

    await saveWorkspaceGiteaToken(tempDir, 'secret-token');

    expect(await readWorkspaceSecrets(tempDir)).toEqual({
      giteaToken: 'secret-token',
      schemaVersion: 1,
    });
    expect(await fs.pathExists(path.join(tempDir, workspaceSecretsFileName))).toBe(true);
    expect(await readWorkspaceConfig(tempDir)).not.toHaveProperty('giteaToken');

    await clearWorkspaceGiteaToken(tempDir);

    expect(await readWorkspaceSecrets(tempDir)).toEqual({
      schemaVersion: 1,
    });
  });

  it('creates Git sources for configured Git targets', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    config.targets.push({
      branch: 'main',
      pythonResolutionMode: 'approximate',
      type: 'git',
      url: 'https://github.com/acme/app.git',
    });

    expect(createWorkspaceGitSources(config)).toEqual([
      {
        committish: 'main',
        host: 'github.com',
        id: 'github.com/acme/app',
        localMirrorPath: 'git-mirrors/github.com/acme/app.git',
        owner: 'acme',
        pythonResolutionMode: 'approximate',
        repo: 'app',
        requirements: [],
        sourceUrl: 'https://github.com/acme/app.git',
        target: true,
      },
    ]);
  });

  it('selects configured targets by one-based indexes', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    config.targets.push(
      {
        branch: 'main',
        pythonResolutionMode: 'approximate',
        type: 'git',
        url: 'https://github.com/acme/app.git',
      },
      {
        spec: 'eslint@latest',
        type: 'npm',
      },
      {
        spec: 'typescript@latest',
        type: 'npm',
      }
    );

    expect(selectWorkspaceTargets(config, [2, 1, 2])).toEqual({
      config: {
        ...config,
        targets: [
          {
            spec: 'eslint@latest',
            type: 'npm',
          },
          {
            branch: 'main',
            pythonResolutionMode: 'approximate',
            type: 'git',
            url: 'https://github.com/acme/app.git',
          },
        ],
      },
      selectedIndexes: [2, 1],
      selectedTargets: [
        {
          spec: 'eslint@latest',
          type: 'npm',
        },
        {
          branch: 'main',
          pythonResolutionMode: 'approximate',
          type: 'git',
          url: 'https://github.com/acme/app.git',
        },
      ],
    });
  });

  it('rejects target selections outside the configured range', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    config.targets.push({
      spec: 'eslint@latest',
      type: 'npm',
    });

    expect(() => selectWorkspaceTargets(config, [2])).toThrow(
      'Target index must be between 1 and 1'
    );
  });

  it('creates a portable workspace snapshot for later verification', async () => {
    const config = await initWorkspace({ legacy: true, workspaceDir: tempDir });
    config.targets.push(
      {
        branch: 'main',
        pythonResolutionMode: 'approximate',
        type: 'git',
        url: 'https://github.com/acme/app.git',
      },
      {
        spec: 'eslint@latest',
        type: 'npm',
      }
    );
    expect(
      createWorkspaceSnapshot({
        config,
        createdAt: '2026-05-21T00:00:00.000Z',
      })
    ).toEqual({
      createdAt: '2026-05-21T00:00:00.000Z',
      gitOwnerStrategy: 'preserve',
      output: './airgap-bundle',
      pythonResolutionMode: 'locked-only',
      schemaVersion: 1,
      sourceRegistry: 'https://registry.npmjs.org',
      targets: [
        {
          branch: 'main',
          localMirrorPath: 'git-mirrors/github.com/acme/app.git',
          pythonResolutionMode: 'approximate',
          sourceId: 'github.com/acme/app',
          type: 'git',
          url: 'https://github.com/acme/app.git',
        },
        {
          spec: 'eslint@latest',
          type: 'npm',
        },
      ],
    });
  });

  it('normalizes and round-trips schema-v2 Python application intents', async () => {
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      {
        coveragePolicies: [
          {
            id: 'desktop-x64',
            platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
            wheelStrategy: 'all-compatible',
          },
        ],
        output: './airgap-bundle',
        python: {
          applicationArtifactOwner: ' python-apps ',
          artifactTransfer: {
            cpython: true,
            uv: true,
          },
          planner: {
            engine: 'uv',
            version: 'pinned-by-airgap-sync',
          },
          publishOwner: ' pypi ',
          sourceIndex: 'https://pypi.org/simple',
        },
        schemaVersion: 2,
        sourceRegistry: 'https://registry.npmjs.org',
        targets: [
          {
            coverage: 'desktop-x64',
            spec: 'ktransformers',
            type: 'python-app',
          },
        ],
      },
      { spaces: 2 }
    );

    const config = await readWorkspaceConfig(tempDir);
    expect(config).toMatchObject({
      coveragePolicies: [
        {
          id: 'desktop-x64',
          platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
          version: 1,
          wheelStrategy: 'all-compatible',
        },
      ],
      python: {
        artifactTransfer: {
          cpython: true,
          uv: true,
        },
        planner: {
          engine: 'uv',
          version: '0.11.16',
        },
        publication: {
          owner: {
            kind: 'organization',
            name: 'airgap-packages',
            strategy: 'fixed-owner',
          },
          visibility: 'public',
        },
        sourceIndex: 'https://pypi.org/simple',
      },
      schemaVersion: 2,
      targets: [
        {
          application: {
            extras: [],
            features: {},
          },
          coverage: 'desktop-x64',
          python: {
            policy: 'auto',
          },
          spec: 'ktransformers',
          type: 'python-app',
        },
      ],
    });

    await writeWorkspaceConfig(tempDir, config);
    expect(await readWorkspaceConfig(tempDir)).toEqual(config);
    expect(
      resolveWorkspacePythonApplication(
        config,
        config.targets[0] as Extract<(typeof config.targets)[number], { type: 'python-app' }>
      )
    ).toMatchObject({
      coveragePolicy: {
        id: 'desktop-x64',
      },
      intent: {
        application: {
          name: 'ktransformers',
        },
        coverage: {
          policyId: 'desktop-x64',
        },
        python: {
          policy: 'auto',
        },
        source: {
          indexUrl: 'https://pypi.org/simple',
          type: 'pypi',
        },
      },
    });
  });

  it('previews schema-v1 migration without changing the workspace', async () => {
    const config = await initWorkspace({ legacy: true, workspaceDir: tempDir });
    config.pythonPublishOwner = 'pypi';
    config.pythonSourceIndex = 'https://pypi.org/simple/';
    config.pythonTargetEnvironments = [
      {
        arch: 'x86_64',
        manylinux: 'manylinux_2_17',
        name: 'prod-linux',
        os: 'linux',
        pythonVersion: '3.11.9',
      },
    ];
    config.targets.push(
      {
        branch: 'main',
        type: 'git',
        url: 'https://github.com/acme/app.git',
      },
      {
        spec: 'eslint@latest',
        type: 'npm',
      },
      {
        spec: 'requests==2.32.3',
        type: 'pypi',
      },
      {
        sha256: 'a'.repeat(64),
        type: 'python-wheel',
        url: 'https://example.test/packages/demo-1.0.0-py3-none-any.whl',
      },
      {
        pythonVersion: '3.11.9',
        sha256: 'b'.repeat(64),
        type: 'python-runtime',
        url: 'https://example.test/runtimes/cpython-3.11.9.tar.gz',
      }
    );

    const migrated = previewWorkspaceConfigMigration(config);

    expect(migrated).toMatchObject({
      coveragePolicies: [],
      python: {
        legacySeed: {
          resolutionMode: 'locked-only',
          targetEnvironments: config.pythonTargetEnvironments,
        },
        planner: {
          engine: 'uv',
          version: '0.11.16',
        },
        publishOwner: 'pypi',
        sourceIndex: 'https://pypi.org/simple/',
      },
      schemaVersion: 2,
      targets: config.targets,
    });
    expect(migrated).not.toHaveProperty('pythonResolutionMode');
    expect(migrated).not.toHaveProperty('pythonTargetEnvironments');
    expect(workspaceLegacyPythonSettings(migrated)).toEqual({
      publishOwner: 'pypi',
      resolutionMode: 'locked-only',
      sourceIndex: 'https://pypi.org/simple/',
      targetEnvironments: config.pythonTargetEnvironments,
    });
    expect(
      createWorkspaceSnapshot({
        config: migrated,
        createdAt: '2026-07-27T00:00:00.000Z',
      })
    ).toMatchObject({
      pythonResolutionMode: 'locked-only',
      pythonTargetEnvironments: config.pythonTargetEnvironments,
      schemaVersion: 2,
    });
    expect(
      (await fs.readJson<{ schemaVersion: number }>(path.join(tempDir, 'airgap-sync.json')))
        .schemaVersion
    ).toBe(1);
    expect(previewWorkspaceConfigMigration(migrated)).toEqual(migrated);
  });

  it('automatically migrates schema v1 once with an exact backup', async () => {
    const legacy = await initWorkspace({ legacy: true, workspaceDir: tempDir });
    legacy.pythonSourceIndex = 'https://packages.example/simple/';
    await fs.writeJson(path.join(tempDir, 'airgap-sync.json'), legacy, { spaces: 2 });
    const original = await fs.readFile(path.join(tempDir, 'airgap-sync.json'), 'utf8');

    expect((await previewWorkspaceMigration(tempDir)).schemaVersion).toBe(2);
    expect(
      (await fs.readJson<{ schemaVersion: number }>(path.join(tempDir, 'airgap-sync.json')))
        .schemaVersion
    ).toBe(1);

    const first = await migrateWorkspaceConfig(tempDir);

    expect(first.appliedMigrationIds).toEqual([
      '0001-workspace-schema-v2',
      '0002-python-application-publication',
      '0003-python-publication-profile',
      '0004-python-runtime-transfer',
    ]);
    expect(first.config).toMatchObject({
      python: {
        artifactTransfer: {
          cpython: true,
          uv: false,
        },
        legacySeed: {
          resolutionMode: 'locked-only',
        },
        publication: {
          owner: {
            kind: 'organization',
            name: 'airgap-packages',
            strategy: 'fixed-owner',
          },
          visibility: 'public',
        },
        sourceIndex: 'https://packages.example/simple/',
      },
      schemaVersion: 2,
    });
    expect(await fs.readFile(path.join(tempDir, workspaceConfigV1BackupFileName), 'utf8')).toBe(
      original
    );
    expect(
      await fs.pathExists(
        path.join(tempDir, '.airgap-sync', 'recipes', 'ktransformers-0.6.1.post1.json')
      )
    ).toBe(true);

    const second = await migrateWorkspaceConfig(tempDir);

    expect(second.appliedMigrationIds).toEqual([]);
    expect(second.backupPath).toBeUndefined();
    expect(await fs.readFile(path.join(tempDir, workspaceConfigV1BackupFileName), 'utf8')).toBe(
      original
    );
  });

  it('adds missing Python publication defaults to schema v2 once', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    delete config.python!.applicationArtifactOwner;
    delete config.python!.publication;
    await fs.writeJson(path.join(tempDir, 'airgap-sync.json'), config, { spaces: 2 });
    const original = await fs.readFile(path.join(tempDir, 'airgap-sync.json'), 'utf8');

    const first = await migrateWorkspaceConfig(tempDir);

    expect(first.appliedMigrationIds).toEqual([
      '0002-python-application-publication',
      '0003-python-publication-profile',
    ]);
    expect(first.backupPath).toBe(
      path.join(tempDir, workspaceConfigPythonPublicationBackupFileName)
    );
    expect(first.config.python).toMatchObject({
      publication: {
        owner: {
          kind: 'organization',
          name: 'airgap-packages',
          strategy: 'fixed-owner',
        },
        visibility: 'public',
      },
      sourceIndex: 'https://pypi.org/simple/',
    });
    expect(
      await fs.readFile(path.join(tempDir, workspaceConfigPythonPublicationBackupFileName), 'utf8')
    ).toBe(original);

    const second = await migrateWorkspaceConfig(tempDir);

    expect(second.appliedMigrationIds).toEqual([]);
    expect(second.backupPath).toBeUndefined();
  });

  it('requires an explicit owner kind for custom legacy Python owners', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    delete config.python!.publication;
    config.python!.publishOwner = 'custom-pypi';
    await fs.writeJson(path.join(tempDir, 'airgap-sync.json'), config, { spaces: 2 });

    await expect(migrateWorkspaceConfig(tempDir)).rejects.toThrow(
      'Configure python.publication.owner with an explicit strategy and owner kind'
    );
    expect(
      await fs.pathExists(path.join(tempDir, workspaceConfigPythonPublicationProfileBackupFileName))
    ).toBe(false);
  });

  it('does not create a backup when legacy configuration is invalid', async () => {
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      {
        output: './airgap-bundle',
        schemaVersion: 1,
        sourceRegistry: 'https://registry.npmjs.org',
        targets: [{ spec: 'requests', type: 'pypi' }],
      },
      { spaces: 2 }
    );

    await expect(readWorkspaceConfig(tempDir)).rejects.toThrow(
      'pypi targets require pythonTargetEnvironments'
    );
    expect(await fs.pathExists(path.join(tempDir, workspaceConfigV1BackupFileName))).toBe(false);
    expect(
      (await fs.readJson<{ schemaVersion: number }>(path.join(tempDir, 'airgap-sync.json')))
        .schemaVersion
    ).toBe(1);
  });

  it('rejects schema-v2 application intents with unknown coverage', async () => {
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      {
        coveragePolicies: [],
        output: './airgap-bundle',
        schemaVersion: 2,
        sourceRegistry: 'https://registry.npmjs.org',
        targets: [
          {
            coverage: 'missing',
            spec: 'demo-app',
            type: 'python-app',
          },
        ],
      },
      { spaces: 2 }
    );

    await expect(readWorkspaceConfig(tempDir)).rejects.toThrow('unknown coverage policy: missing');
  });
});
