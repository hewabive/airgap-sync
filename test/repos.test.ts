import os from 'node:os';
import path from 'node:path';
import * as fs from '../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findGitRepositories,
  updateRepositories,
  type GitOutputCommandInvocation,
  type GitOutputCommandRunner,
} from '../src/index.js';

let root: string;

async function makeRepo(relativePath: string): Promise<string> {
  const repo = path.join(root, relativePath);
  await fs.ensureDir(path.join(repo, '.git'));
  return repo;
}

describe('findGitRepositories', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-repos-'));
  });

  afterEach(async () => {
    await fs.remove(root);
  });

  it('finds git repositories and skips nested repositories under a discovered repo', async () => {
    const alpha = await makeRepo('alpha');
    const beta = await makeRepo('nested/beta');
    await makeRepo('alpha/vendor/inner');
    await makeRepo('node_modules/ignored');

    await expect(findGitRepositories(root)).resolves.toEqual([alpha, beta].sort());
  });
});

describe('updateRepositories', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-repos-'));
  });

  afterEach(async () => {
    await fs.remove(root);
  });

  function createRunner(
    responses: Record<string, { branch?: string; pullError?: string; status?: string }>
  ): { calls: GitOutputCommandInvocation[]; runner: GitOutputCommandRunner } {
    const calls: GitOutputCommandInvocation[] = [];
    const runner: GitOutputCommandRunner = (invocation) => {
      calls.push(invocation);
      const cwd = invocation.cwd;
      if (!cwd) {
        return Promise.reject(new Error('cwd is required'));
      }

      const response = responses[cwd] ?? {};
      const command = invocation.args.join(' ');

      if (command === 'status --porcelain') {
        return Promise.resolve({ stderr: '', stdout: response.status ?? '' });
      }
      if (command === 'rev-parse --abbrev-ref HEAD') {
        return Promise.resolve({ stderr: '', stdout: `${response.branch ?? 'main'}\n` });
      }
      if (command === 'pull --ff-only') {
        if (response.pullError) {
          return Promise.reject(new Error(response.pullError));
        }
        return Promise.resolve({ stderr: '', stdout: 'Already up to date.\n' });
      }

      return Promise.reject(new Error(`Unexpected git command: ${command}`));
    };

    return { calls, runner };
  }

  it('plans clean repositories without pulling in dry-run mode', async () => {
    const repo = await makeRepo('alpha');
    const { calls, runner } = createRunner({
      [repo]: {},
    });

    await expect(
      updateRepositories({
        dryRun: true,
        generatedAt: '2026-05-21T00:00:00.000Z',
        root,
        runner,
      })
    ).resolves.toMatchObject({
      detached: 0,
      dirty: 0,
      dryRun: true,
      errors: [],
      planned: 1,
      totalRepositories: 1,
      updated: 0,
    });
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'status --porcelain',
      'rev-parse --abbrev-ref HEAD',
    ]);
  });

  it('updates clean repositories with git pull --ff-only', async () => {
    const repo = await makeRepo('alpha');
    const { calls, runner } = createRunner({
      [repo]: {},
    });

    const report = await updateRepositories({
      generatedAt: '2026-05-21T00:00:00.000Z',
      root,
      runner,
    });

    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'status --porcelain',
      'rev-parse --abbrev-ref HEAD',
      'pull --ff-only',
    ]);
    expect(report).toMatchObject({
      errors: [],
      planned: 0,
      totalRepositories: 1,
      updated: 1,
    });
  });

  it('reports dirty repositories without pulling', async () => {
    const repo = await makeRepo('alpha');
    const { calls, runner } = createRunner({
      [repo]: {
        status: ' M package.json\n',
      },
    });

    const report = await updateRepositories({
      generatedAt: '2026-05-21T00:00:00.000Z',
      root,
      runner,
    });

    expect(calls.map((call) => call.args.join(' '))).toEqual(['status --porcelain']);
    expect(report).toMatchObject({
      dirty: 1,
      errors: [
        {
          error: 'Working tree has uncommitted changes',
          repository: repo,
          status: 'dirty',
        },
      ],
      updated: 0,
    });
  });

  it('reports detached repositories without pulling', async () => {
    const repo = await makeRepo('alpha');
    const { calls, runner } = createRunner({
      [repo]: {
        branch: 'HEAD',
      },
    });

    const report = await updateRepositories({
      generatedAt: '2026-05-21T00:00:00.000Z',
      root,
      runner,
    });

    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'status --porcelain',
      'rev-parse --abbrev-ref HEAD',
    ]);
    expect(report).toMatchObject({
      detached: 1,
      errors: [
        {
          error: 'Repository is in detached HEAD state',
          repository: repo,
          status: 'detached',
        },
      ],
      updated: 0,
    });
  });

  it('records pull failures and continues reporting', async () => {
    const repo = await makeRepo('alpha');
    const { runner } = createRunner({
      [repo]: {
        pullError: 'Not possible to fast-forward',
      },
    });

    const report = await updateRepositories({
      generatedAt: '2026-05-21T00:00:00.000Z',
      root,
      runner,
    });

    expect(report).toMatchObject({
      errors: [
        {
          error: 'Not possible to fast-forward',
          repository: repo,
          status: 'error',
        },
      ],
      updated: 0,
    });
  });
});
