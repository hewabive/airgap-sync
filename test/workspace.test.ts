import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import {
  addWorkspaceTarget,
  clearWorkspaceGiteaToken,
  createWorkspaceGitSources,
  createWorkspaceSnapshot,
  editWorkspaceTarget,
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
  setWorkspaceTargetPaused,
  setWorkspacePythonApplicationVersionSelection,
  workspaceConfigPythonPublicationBackupFileName,
  workspaceConfigPythonPublicationProfileBackupFileName,
  workspaceConfigNpmRegistryTargetBackupFileName,
  workspaceConfigV1BackupFileName,
  workspaceTargetEditableFields,
  workspaceSecretsFileName,
  writeWorkspaceConfig,
} from '../src/core/workspace.js';

let tempDir: string;

describe('workspace config', () => {
  it('round-trips source policies and includes target overrides in planning intent', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    config.python!.resolution = { prerelease: 'disallow' };
    config.targets = [
      {
        type: 'python-app',
        spec: 'demo',
        application: { extras: [], features: {} },
        resolution: {
          prerelease: 'allow',
          packageIndexes: [
            { indexUrl: 'https://vendor.test/', packages: ['demo'], missingUploadTime: 'allow' },
          ],
        },
      },
    ];
    await writeWorkspaceConfig(tempDir, config);
    const restored = await readWorkspaceConfig(tempDir);
    const target = restored.targets[0]!;
    if (target.type !== 'python-app') throw new Error('wrong target');
    expect(resolveWorkspacePythonApplication(restored, target).intent.source.resolution).toEqual(
      target.resolution
    );
    delete target.resolution;
    expect(resolveWorkspacePythonApplication(restored, target).intent.source.resolution).toEqual({
      prerelease: 'disallow',
    });
  });

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
          wheelStrategy: 'minimum-cover',
        },
      ],
      gitOwnerStrategy: 'preserve',
      output: './airgap-bundle',
      python: {
        applicationDefaults: {
          coverage: 'desktop-x64',
          runtime: {
            policy: 'selected',
            versions: ['3.10', '3.11', '3.12', '3.13'],
          },
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
        type: 'git' as const,
        url: 'https://github.com/acme/app.git',
      },
      {
        spec: 'eslint@latest',
        type: 'npm' as const,
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

  it('pauses and resumes any workspace target without changing its identity', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    await addWorkspaceTarget(tempDir, {
      branch: 'main',
      type: 'git',
      url: 'https://github.com/acme/app.git',
    });

    await expect(setWorkspaceTargetPaused(tempDir, 1, true)).resolves.toMatchObject({
      changed: true,
      target: {
        branch: 'main',
        paused: true,
        type: 'git',
        url: 'https://github.com/acme/app.git',
      },
    });
    const duplicate = await addWorkspaceTarget(tempDir, {
      branch: 'main',
      type: 'git',
      url: 'https://github.com/acme/app.git',
    });
    expect(duplicate.added).toBe(false);
    await expect(setWorkspaceTargetPaused(tempDir, 1, true)).resolves.toMatchObject({
      changed: false,
    });
    await expect(setWorkspaceTargetPaused(tempDir, 1, false)).resolves.toMatchObject({
      changed: true,
      target: {
        branch: 'main',
        type: 'git',
        url: 'https://github.com/acme/app.git',
      },
    });
    expect((await readWorkspaceConfig(tempDir)).targets[0]).not.toHaveProperty('paused');
  });

  it('validates and normalizes the optional paused state', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    config.targets.push({ paused: false, spec: 'eslint@latest', type: 'npm' });
    await writeWorkspaceConfig(tempDir, config);

    expect((await readWorkspaceConfig(tempDir)).targets).toEqual([
      { spec: 'eslint@latest', type: 'npm' },
    ]);

    const stored = await fs.readJson<Record<string, unknown>>(
      path.join(tempDir, 'airgap-sync.json')
    );
    (stored.targets as Record<string, unknown>[])[0]!.paused = 'yes';
    await fs.writeJson(path.join(tempDir, 'airgap-sync.json'), stored, { spaces: 2 });
    await expect(readWorkspaceConfig(tempDir)).rejects.toThrow(
      'Workspace target paused must be a boolean'
    );
  });

  it('normalizes a rolling CPython distribution target', async () => {
    await initWorkspace({ workspaceDir: tempDir });

    const added = await addWorkspaceTarget(tempDir, {
      builds: { windowDays: 365 },
      patches: { latest: 3 },
      platforms: ['windows-x86_64', 'linux-glibc-x86_64', 'windows-x86_64'],
      provider: 'python-build-standalone',
      series: { from: '3.10', major: 3, through: 'latest-stable' },
      type: 'cpython-distributions',
    });

    expect(added.added).toBe(true);
    expect((await readWorkspaceConfig(tempDir)).targets).toEqual([
      {
        builds: { windowDays: 365 },
        patches: { latest: 3 },
        platforms: ['linux-glibc-x86_64', 'windows-x86_64'],
        provider: 'python-build-standalone',
        series: { from: '3.10', major: 3, through: 'latest-stable' },
        type: 'cpython-distributions',
      },
    ]);
  });

  it('edits rolling CPython policy through the common target editor', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    await addWorkspaceTarget(tempDir, {
      builds: { windowDays: 365 },
      patches: { latest: 1 },
      platforms: ['linux-glibc-x86_64'],
      provider: 'python-build-standalone',
      series: { from: '3.10', major: 3, through: 'latest-stable' },
      type: 'cpython-distributions',
    });

    const updated = await editWorkspaceTarget(tempDir, 1, {
      fromMinor: '3.11',
      latest: 3,
      platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
      windowDays: 30,
    });

    expect(updated.changed).toBe(true);
    expect(updated.target).toEqual({
      builds: { windowDays: 30 },
      patches: { latest: 3 },
      platforms: ['linux-glibc-x86_64', 'windows-x86_64'],
      provider: 'python-build-standalone',
      series: { from: '3.11', major: 3, through: 'latest-stable' },
      type: 'cpython-distributions',
    });
    await expect(editWorkspaceTarget(tempDir, 1, { latest: 3 })).resolves.toMatchObject({
      changed: false,
    });
  });

  it('declares editable fields by target type and reports immutable targets', async () => {
    expect(workspaceTargetEditableFields({ spec: 'eslint@latest', type: 'npm' })).toEqual([]);
    expect(
      workspaceTargetEditableFields({
        builds: { windowDays: 365 },
        patches: { latest: 1 },
        platforms: ['linux-glibc-x86_64'],
        provider: 'python-build-standalone',
        series: { from: '3.10', major: 3, through: 'latest-stable' },
        type: 'cpython-distributions',
      })
    ).toEqual(['fromMinor', 'platforms', 'latest', 'windowDays']);
    expect(
      workspaceTargetEditableFields({
        application: { extras: [], features: {} },
        spec: 'orjson',
        type: 'python-app',
      })
    ).toEqual(['coverage', 'python', 'versionSelection']);

    await initWorkspace({ workspaceDir: tempDir });
    await addWorkspaceTarget(tempDir, { spec: 'eslint@latest', type: 'npm' });
    await expect(editWorkspaceTarget(tempDir, 1, {})).rejects.toThrow(
      'npm target has no editable settings'
    );
    await expect(editWorkspaceTarget(tempDir, 1, { latest: 2 })).rejects.toThrow(
      'latest cannot be edited for npm targets'
    );
  });

  it('edits and clears a Git branch without changing target identity', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    await addWorkspaceTarget(tempDir, {
      branch: 'main',
      type: 'git',
      url: 'https://github.com/acme/app.git',
    });

    const updated = await editWorkspaceTarget(tempDir, 1, { branch: 'release' });
    expect(updated.target).toEqual({
      branch: 'release',
      type: 'git',
      url: 'https://github.com/acme/app.git',
    });

    const cleared = await editWorkspaceTarget(tempDir, 1, { branch: null });
    expect(cleared.target).toEqual({
      type: 'git',
      url: 'https://github.com/acme/app.git',
    });
  });

  it('expands legacy automatic Python coverage to the initial supported minor matrix', async () => {
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
          policy: 'selected',
          versions: ['3.10', '3.11', '3.12', '3.13'],
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

  it('inherits workspace Python defaults and can add or clear independent overrides', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    config.coveragePolicies![0] = {
      ...config.coveragePolicies![0]!,
      platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
    };
    config.python!.applicationDefaults = {
      coverage: 'desktop-x64',
      runtime: { policy: 'selected', versions: ['3.11', '3.12'] },
    };
    await writeWorkspaceConfig(tempDir, config);

    await addWorkspaceTarget(tempDir, {
      application: { extras: [], features: {} },
      spec: 'orjson',
      type: 'python-app',
    });

    let current = await readWorkspaceConfig(tempDir);
    let target = current.targets[0];
    expect(target).toEqual({
      application: { extras: [], features: {} },
      spec: 'orjson',
      type: 'python-app',
    });
    if (target?.type !== 'python-app') throw new Error('Expected a python-app target');
    expect(resolveWorkspacePythonApplication(current, target)).toMatchObject({
      coveragePolicy: {
        platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
      },
      intent: {
        python: { policy: 'selected', versions: ['3.11', '3.12'] },
      },
    });

    await editWorkspaceTarget(tempDir, 1, {
      coverage: {
        platforms: ['linux-glibc-x86_64'],
        version: 1,
        wheelStrategy: 'minimum-cover',
      },
      python: { policy: 'selected', versions: ['3.12'] },
    });
    current = await readWorkspaceConfig(tempDir);
    target = current.targets[0];
    expect(target).toMatchObject({
      coverage: { platforms: ['linux-glibc-x86_64'] },
      python: { policy: 'selected', versions: ['3.12'] },
    });
    if (target?.type !== 'python-app') throw new Error('Expected a python-app target');
    expect(resolveWorkspacePythonApplication(current, target).intent.python).toEqual({
      policy: 'selected',
      versions: ['3.12'],
    });

    await editWorkspaceTarget(tempDir, 1, { coverage: null, python: null });
    target = (await readWorkspaceConfig(tempDir)).targets[0];
    expect(target).not.toHaveProperty('coverage');
    expect(target).not.toHaveProperty('python');
  });

  it('treats inherited and equivalent explicit coverage as the same application selection', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    await addWorkspaceTarget(tempDir, {
      application: { extras: [], features: {} },
      spec: 'orjson',
      type: 'python-app',
    });

    await expect(
      addWorkspaceTarget(tempDir, {
        application: {
          extras: [],
          features: {},
          versionSelection: { selectors: [{ type: 'exact', version: '3.0.0' }] },
        },
        coverage: 'desktop-x64',
        spec: 'orjson',
        type: 'python-app',
      })
    ).rejects.toThrow('update its version selection instead');
  });

  it('normalizes exact/latest application version selectors', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    await addWorkspaceTarget(tempDir, {
      application: {
        extras: [],
        features: {},
        versionSelection: {
          selectors: [
            { type: 'exact', version: ' 0.25.1 ' },
            { type: 'latest-compatible' },
            { type: 'exact', version: '0.25.1' },
          ],
        },
      },
      coverage: 'desktop-x64',
      python: { policy: 'selected', versions: ['3.12'] },
      spec: 'vllm',
      type: 'python-app',
    });

    const target = (await readWorkspaceConfig(tempDir)).targets[0];
    expect(target).toMatchObject({
      application: {
        versionSelection: {
          selectors: [{ type: 'exact', version: '0.25.1' }, { type: 'latest-compatible' }],
        },
      },
    });
    if (target?.type !== 'python-app') {
      throw new Error('Expected a python-app target');
    }
    const resolved = resolveWorkspacePythonApplication(await readWorkspaceConfig(tempDir), target);
    expect(resolved.versionSelection.selectors).toEqual([
      { type: 'exact', version: '0.25.1' },
      { type: 'latest-compatible' },
    ]);
  });

  it('rejects conflicting or invalid application version selectors', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    const base = {
      coverage: 'desktop-x64',
      python: { policy: 'auto' as const },
      spec: 'vllm',
      type: 'python-app' as const,
    };

    await expect(
      addWorkspaceTarget(tempDir, {
        ...base,
        application: {
          extras: [],
          features: {},
          version: '>=0.25',
          versionSelection: { selectors: [{ type: 'latest-compatible' }] },
        },
      })
    ).rejects.toThrow('either application.version or application.versionSelection');
    await expect(
      addWorkspaceTarget(tempDir, {
        ...base,
        application: {
          extras: [],
          features: {},
          versionSelection: { selectors: [{ type: 'exact', version: 'latest' }] },
        },
      })
    ).rejects.toThrow('Invalid exact python-app version');
    expect(config.targets).toEqual([]);
  });

  it('updates version selectors on the existing application target and rejects a colliding target', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    const baseTarget = {
      application: { extras: [], features: {} },
      coverage: 'desktop-x64',
      python: { policy: 'selected' as const, versions: ['3.12'] },
      spec: 'vllm',
      type: 'python-app' as const,
    };
    await addWorkspaceTarget(tempDir, baseTarget);

    await expect(
      addWorkspaceTarget(tempDir, {
        ...baseTarget,
        application: {
          ...baseTarget.application,
          versionSelection: { selectors: [{ type: 'exact', version: '0.25.1' }] },
        },
      })
    ).rejects.toThrow('update its version selection instead');

    const updated = await setWorkspacePythonApplicationVersionSelection(tempDir, 1, {
      selectors: [{ type: 'exact', version: '0.25.1' }, { type: 'latest-compatible' }],
    });
    expect(updated.target.application).toMatchObject({
      versionSelection: {
        selectors: [{ type: 'exact', version: '0.25.1' }, { type: 'latest-compatible' }],
      },
    });
    expect(updated.config.targets).toHaveLength(1);
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
      npmRegistry: {
        type: 'verdaccio',
        url: 'http://verdaccio.local:4873',
      },
    });
  });

  it('migrates a legacy targetRegistry into a typed Verdaccio target', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      { ...config, targetRegistry: 'http://verdaccio.local:4873/' },
      { spaces: 2 }
    );

    const migration = await migrateWorkspaceConfig(tempDir);
    expect(migration.appliedMigrationIds).toEqual(['0004-npm-registry-target']);
    expect(migration.config.npmRegistry).toEqual({
      type: 'verdaccio',
      url: 'http://verdaccio.local:4873',
    });
    expect(migration.backupPath).toBe(
      path.join(tempDir, workspaceConfigNpmRegistryTargetBackupFileName)
    );
  });

  it('normalizes a Gitea npm target without storing a second service URL', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    await writeWorkspaceConfig(tempDir, {
      ...config,
      giteaUrl: 'http://gitea.local',
      npmRegistry: {
        owner: {
          kind: 'organization',
          name: 'airgap-packages',
          strategy: 'fixed-owner',
        },
        type: 'gitea',
        visibility: 'public',
      },
    });

    const stored = await fs.readJson<Record<string, unknown>>(
      path.join(tempDir, 'airgap-sync.json')
    );
    expect(stored).not.toHaveProperty('targetRegistry');
    expect(stored.npmRegistry).toEqual({
      owner: {
        kind: 'organization',
        name: 'airgap-packages',
        strategy: 'fixed-owner',
      },
      type: 'gitea',
      visibility: 'public',
    });
  });

  it('normalizes persistent npm security policy', async () => {
    await initWorkspace({ workspaceDir: tempDir });
    const configPath = path.join(tempDir, 'airgap-sync.json');
    const config = await fs.readJson<Record<string, unknown>>(configPath);
    await fs.writeJson(
      configPath,
      {
        ...config,
        npmSecurity: {
          allowPackages: ['native-addon@1.0.0#sha256:abc123'],
          maxReportAgeHours: 24,
          minReleaseAgeDays: 7,
          vulnerabilityResolutionPolicy: 'report-only',
        },
      },
      { spaces: 2 }
    );

    await expect(readWorkspaceConfig(tempDir)).resolves.toMatchObject({
      npmSecurity: {
        allowPackages: ['native-addon@1.0.0#sha256:abc123'],
        maxReportAgeHours: 24,
        minReleaseAgeDays: 7,
        vulnerabilityResolutionPolicy: 'report-only',
      },
    });
  });

  it('rejects removed legacy Python targets and settings', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      {
        ...config,
        python: { ...config.python, legacySeed: { resolutionMode: 'locked-only' } },
      },
      { spaces: 2 }
    );
    await expect(readWorkspaceConfig(tempDir)).rejects.toThrow('python.legacySeed was removed');

    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      { ...config, targets: [{ spec: 'requests==2.32.3', type: 'pypi' }] },
      { spaces: 2 }
    );
    await expect(readWorkspaceConfig(tempDir)).rejects.toThrow(
      'pypi targets were removed with legacy Python seeding'
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
        type: 'git',
        url: 'https://github.com/acme/app.git',
      },
      {
        paused: true,
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
            paused: true,
            spec: 'eslint@latest',
            type: 'npm',
          },
          {
            branch: 'main',
            type: 'git',
            url: 'https://github.com/acme/app.git',
          },
        ],
      },
      selectedIndexes: [2, 1],
      selectedTargets: [
        {
          paused: true,
          spec: 'eslint@latest',
          type: 'npm',
        },
        {
          branch: 'main',
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
    const config = await initWorkspace({ workspaceDir: tempDir });
    config.targets.push(
      {
        branch: 'main',
        type: 'git',
        url: 'https://github.com/acme/app.git',
      },
      {
        paused: true,
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
      python: config.python,
      coveragePolicies: config.coveragePolicies,
      schemaVersion: 2,
      sourceRegistry: 'https://registry.npmjs.org',
      targets: [
        {
          branch: 'main',
          localMirrorPath: 'git-mirrors/github.com/acme/app.git',
          sourceId: 'github.com/acme/app',
          type: 'git',
          url: 'https://github.com/acme/app.git',
        },
        {
          paused: true,
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
            uvVersions: [' 0.11.16 ', '0.12.1', '0.11.16'],
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
          wheelStrategy: 'minimum-cover',
        },
      ],
      python: {
        applicationDefaults: {
          coverage: 'desktop-x64',
          runtime: {
            policy: 'selected',
            versions: ['3.10', '3.11', '3.12', '3.13'],
          },
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
          spec: 'ktransformers',
          type: 'python-app',
        },
      ],
    });
    expect(config.python).not.toHaveProperty('artifactTransfer');

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
          policy: 'selected',
          versions: ['3.10', '3.11', '3.12', '3.13'],
        },
        source: {
          indexUrl: 'https://pypi.org/simple',
          type: 'pypi',
        },
      },
    });
  });

  it('previews schema-v1 migration without changing the workspace', async () => {
    const initialized = await initWorkspace({ workspaceDir: tempDir });
    const common = { ...initialized };
    delete common.coveragePolicies;
    delete common.python;
    const config = {
      ...common,
      pythonPublishOwner: 'pypi',
      pythonSourceIndex: 'https://pypi.org/simple/',
      schemaVersion: 1 as const,
      targets: [
        {
          branch: 'main',
          type: 'git' as const,
          url: 'https://github.com/acme/app.git',
        },
        {
          spec: 'eslint@latest',
          type: 'npm' as const,
        },
      ],
    };
    await fs.writeJson(path.join(tempDir, 'airgap-sync.json'), config, { spaces: 2 });

    const migrated = previewWorkspaceConfigMigration(config);

    expect(migrated).toMatchObject({
      coveragePolicies: [],
      python: {
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
    expect(
      (await fs.readJson<{ schemaVersion: number }>(path.join(tempDir, 'airgap-sync.json')))
        .schemaVersion
    ).toBe(1);
    expect(previewWorkspaceConfigMigration(migrated)).toEqual(migrated);
  });

  it('automatically migrates schema v1 once with an exact backup', async () => {
    const initialized = await initWorkspace({ workspaceDir: tempDir });
    const common = { ...initialized };
    delete common.coveragePolicies;
    delete common.python;
    const legacy = {
      ...common,
      pythonSourceIndex: 'https://packages.example/simple/',
      schemaVersion: 1 as const,
    };
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
    ]);
    expect(first.config).toMatchObject({
      python: {
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

  it('does not create a backup for a removed legacy Python target', async () => {
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
      'pypi targets were removed with legacy Python seeding'
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

  it('rejects an unknown workspace default coverage policy', async () => {
    await fs.writeJson(
      path.join(tempDir, 'airgap-sync.json'),
      {
        coveragePolicies: [],
        output: './airgap-bundle',
        python: {
          applicationDefaults: {
            coverage: 'missing',
            runtime: { policy: 'selected', versions: ['3.12'] },
          },
          sourceIndex: 'https://pypi.org/simple/',
        },
        schemaVersion: 2,
        sourceRegistry: 'https://registry.npmjs.org',
        targets: [],
      },
      { spaces: 2 }
    );

    await expect(readWorkspaceConfig(tempDir)).rejects.toThrow(
      'python.applicationDefaults references unknown coverage policy: missing'
    );
  });
});
