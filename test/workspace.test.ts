import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import {
  addWorkspaceTarget,
  gitTargetLocalPath,
  initWorkspace,
  materializeWorkspaceGitTargets,
  readWorkspaceConfig,
  removeWorkspaceTarget,
} from '../src/core/workspace.js';
import type { GitCommandInvocation } from '../src/core/git-fetch.js';

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
      output: './bundle',
      reposDir: './repos',
      schemaVersion: 1,
      sourceRegistry: 'https://registry.npmjs.org',
      targets: [],
    });
    expect(await fs.pathExists(path.join(tempDir, 'airgap-sync.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, 'repos'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, 'bundle'))).toBe(true);
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

  it('materializes missing Git targets under preserved source paths', async () => {
    const config = await initWorkspace({ workspaceDir: tempDir });
    config.targets.push({
      branch: 'main',
      type: 'git',
      url: 'https://github.com/acme/app.git',
    });

    const calls: GitCommandInvocation[] = [];
    const report = await materializeWorkspaceGitTargets({
      config,
      workspaceDir: tempDir,
      async runner(invocation) {
        calls.push(invocation);
        await fs.ensureDir(invocation.args.at(-1) ?? '');
      },
    });

    expect(gitTargetLocalPath(tempDir, config, 'https://github.com/acme/app.git')).toBe(
      path.join(tempDir, 'repos/github.com/acme/app')
    );
    expect(calls).toEqual([
      {
        args: [
          'clone',
          '--branch',
          'main',
          'https://github.com/acme/app.git',
          path.join(tempDir, 'repos/github.com/acme/app'),
        ],
      },
    ]);
    expect(report).toMatchObject({
      cloned: 1,
      errors: [],
      totalRepositories: 1,
    });
  });
});
