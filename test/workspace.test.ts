import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import {
  addWorkspaceTarget,
  clearWorkspaceGiteaToken,
  createWorkspaceGitSources,
  createWorkspaceSnapshot,
  initWorkspace,
  readWorkspaceConfig,
  readWorkspaceSecrets,
  removeWorkspaceTarget,
  saveWorkspaceGiteaToken,
  selectWorkspaceTargets,
  workspaceSecretsFileName,
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
          includeDev: 'ask',
          includePeer: false,
          latestPolicy: 'bundled',
          prune: false,
          rangeResolutionPolicy: 'reuse-stable',
          tagResolutionPolicy: 'reuse-stable',
        },
        publish: {
          configureGitGlobal: 'ask',
          publicRepositories: false,
        },
        verifyInstall: {
          ignoreScripts: true,
        },
      },
      output: './airgap-bundle',
      schemaVersion: 1,
      sourceRegistry: 'https://registry.npmjs.org',
      targets: [],
    });
    expect(await fs.pathExists(path.join(tempDir, 'airgap-sync.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, 'airgap-bundle'))).toBe(true);
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
          includeDev: 'ask',
          includePeer: false,
          latestPolicy: 'bundled',
          prune: false,
          rangeResolutionPolicy: 'reuse-stable',
          tagResolutionPolicy: 'reuse-stable',
        },
        publish: {
          configureGitGlobal: 'ask',
          publicRepositories: false,
        },
        verifyInstall: {
          ignoreScripts: true,
        },
      },
      giteaUrl: 'http://gitea.local',
      targetRegistry: 'http://verdaccio.local:4873',
    });
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
      output: './airgap-bundle',
      schemaVersion: 1,
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
          spec: 'eslint@latest',
          type: 'npm',
        },
      ],
    });
  });
});
