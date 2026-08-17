import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import { runGitCommand } from '../src/core/git-fetch.js';
import { startGitMigrationSourceServer } from '../src/core/git-migration-source.js';
import type { GitSource } from '../src/types.js';

let tempDir: string;

const source: GitSource = {
  host: 'github.com',
  id: 'github.com/owner/repo',
  localMirrorPath: 'git-mirrors/github.com/owner/repo.git',
  owner: 'owner',
  repo: 'repo',
  requirements: [],
  sourceUrl: 'https://github.com/owner/repo.git',
};

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-git-migration-'));
});

afterEach(async () => {
  await fs.remove(tempDir);
});

describe('Git migration source server', () => {
  it('rejects unsafe advertised hosts and invalid ports before listening', async () => {
    await expect(
      startGitMigrationSourceServer({
        advertisedHost: 'localhost@untrusted.example',
        bundleDir: tempDir,
        sources: [],
      })
    ).rejects.toThrow('Invalid Git migration advertised host');
    await expect(
      startGitMigrationSourceServer({
        bundleDir: tempDir,
        port: 65_536,
        sources: [],
      })
    ).rejects.toThrow('Invalid Git migration server port');
  });

  it('serves one authenticated read-only smart HTTP clone', async () => {
    const worktree = path.join(tempDir, 'worktree');
    const mirror = path.join(tempDir, source.localMirrorPath);
    await fs.ensureDir(worktree);
    await runGitCommand({ args: ['-C', worktree, 'init', '--initial-branch=main'] });
    await fs.writeFile(path.join(worktree, 'README.md'), 'migration fixture\n');
    await runGitCommand({ args: ['-C', worktree, 'add', 'README.md'] });
    await runGitCommand({
      args: [
        '-C',
        worktree,
        '-c',
        'user.name=airgap-sync',
        '-c',
        'user.email=airgap-sync@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
    });
    await fs.ensureDir(path.dirname(mirror));
    await runGitCommand({ args: ['clone', '--mirror', worktree, mirror] });
    const head = (
      await runGitCommand({ args: ['--git-dir', mirror, 'rev-parse', 'refs/heads/main'] })
    ).stdout.trim();
    const tagsDir = path.join(mirror, 'refs/tags');
    await fs.ensureDir(tagsDir);
    await Promise.all(
      Array.from({ length: 1_200 }, (_, index) =>
        fs.writeFile(path.join(tagsDir, `build-${String(index).padStart(4, '0')}`), `${head}\n`)
      )
    );
    await fs.ensureDir(path.join(mirror, 'refs/pull/1'));
    await fs.writeFile(path.join(mirror, 'refs/pull/1/head'), `${head}\n`);

    const server = await startGitMigrationSourceServer({
      bundleDir: tempDir,
      sources: [source],
    });
    try {
      const cloneUrl = server.cloneUrl(source);
      await expect(fetch(`${cloneUrl}/info/refs?service=git-upload-pack`)).resolves.toMatchObject({
        status: 401,
      });

      const destination = path.join(tempDir, 'destination.git');
      const authorization = Buffer.from(
        `${server.credentials.username}:${server.credentials.password}`
      ).toString('base64');
      const authenticatedCloneUrl = new URL(cloneUrl);
      authenticatedCloneUrl.username = server.credentials.username;
      authenticatedCloneUrl.password = server.credentials.password;
      await runGitCommand({
        args: ['clone', '--mirror', '--quiet', authenticatedCloneUrl.toString(), destination],
      });

      await expect(
        runGitCommand({ args: ['--git-dir', destination, 'show', 'main:README.md'] })
      ).resolves.toMatchObject({ stdout: 'migration fixture\n' });
      const tags = await runGitCommand({
        args: ['--git-dir', destination, 'for-each-ref', '--format=%(refname)', 'refs/tags'],
      });
      expect(tags.stdout.trim().split('\n')).toHaveLength(1_200);
      await expect(
        runGitCommand({
          args: ['--git-dir', destination, 'show-ref', '--verify', 'refs/pull/1/head'],
        })
      ).rejects.toThrow();
      await expect(
        fetch(`${new URL(cloneUrl).origin}/repositories/not-exported.git/info/refs`, {
          headers: { Authorization: `Basic ${authorization}` },
        })
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        fetch(`${cloneUrl}/git-receive-pack`, {
          headers: { Authorization: `Basic ${authorization}` },
          method: 'POST',
        })
      ).resolves.toMatchObject({ status: 405 });
    } finally {
      await server.close();
    }
  });
});
