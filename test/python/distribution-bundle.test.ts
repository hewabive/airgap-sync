import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as fs from '../../src/core/fs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadCpythonDistributionBundle,
  readCpythonDistributionBundleIndex,
  verifyCpythonDistributionBundle,
  type CpythonDistributionCandidate,
  type WorkspaceCpythonDistributionsTarget,
} from '../../src/index.js';

let bundleDir: string;

function target(): WorkspaceCpythonDistributionsTarget {
  return {
    builds: { windowDays: 30 },
    patches: { latest: 1 },
    platforms: ['linux-glibc-x86_64'],
    provider: 'python-build-standalone',
    series: { from: '3.12', major: 3, through: 'latest-stable' },
    type: 'cpython-distributions',
  };
}

function candidate(content: Buffer): CpythonDistributionCandidate {
  const filename = 'cpython-3.12.13+20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz';
  return {
    filename,
    platformFamilyId: 'linux-glibc-x86_64',
    provider: 'python-build-standalone',
    providerBuild: '20260805',
    providerPublishedAt: '2026-08-05T12:00:00.000Z',
    pythonVersion: '3.12.13',
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.length,
    sourceUrl: `https://github.example/releases/${filename}`,
  };
}

describe('CPython distribution bundle', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-cpython-bundle-'));
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('downloads verified content-addressed artifacts and reuses them on the next run', async () => {
    const content = Buffer.from('portable-cpython-distribution');
    const artifact = candidate(content);
    let fetches = 0;
    const fetch: typeof globalThis.fetch = () => {
      fetches++;
      return Promise.resolve(
        new Response(content, {
          headers: { 'content-length': String(content.length) },
        })
      );
    };

    const first = await downloadCpythonDistributionBundle({
      bundleDir,
      candidates: [artifact],
      fetch,
      generatedAt: '2026-08-06T00:00:00.000Z',
      targets: [target()],
    });
    const index = await readCpythonDistributionBundleIndex(bundleDir);

    expect(first).toMatchObject({ downloaded: 1, errors: [], selected: 1, skipped: 0 });
    expect(index?.artifacts).toHaveLength(1);
    expect(index?.artifacts[0]?.file).toBe(
      `python/distributions/artifacts/${artifact.sha256}/${artifact.filename}`
    );
    await expect(verifyCpythonDistributionBundle(bundleDir)).resolves.toEqual([]);

    const second = await downloadCpythonDistributionBundle({
      bundleDir,
      candidates: [artifact],
      fetch,
      generatedAt: '2026-08-07T00:00:00.000Z',
      targets: [target()],
    });

    expect(second).toMatchObject({ downloaded: 0, errors: [], selected: 1, skipped: 1 });
    expect(fetches).toBe(1);
  });

  it('detects same-size artifact corruption', async () => {
    const content = Buffer.from('portable-cpython-distribution');
    const artifact = candidate(content);
    await downloadCpythonDistributionBundle({
      bundleDir,
      candidates: [artifact],
      fetch: () =>
        Promise.resolve(
          new Response(content, {
            headers: { 'content-length': String(content.length) },
          })
        ),
      generatedAt: '2026-08-06T00:00:00.000Z',
      targets: [target()],
    });
    const index = await readCpythonDistributionBundleIndex(bundleDir);
    expect(index).toBeDefined();
    const indexedArtifact = index?.artifacts[0];
    expect(indexedArtifact).toBeDefined();
    const file = path.join(bundleDir, indexedArtifact?.file ?? 'missing');
    await fs.writeFile(file, Buffer.alloc(content.length, 1));

    await expect(verifyCpythonDistributionBundle(bundleDir)).resolves.toEqual([
      expect.stringContaining('SHA-256 mismatch'),
    ]);
  });
});
