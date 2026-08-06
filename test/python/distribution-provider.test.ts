import { describe, expect, it } from 'vitest';
import {
  discoverCpythonDistributionCandidates,
  type WorkspaceCpythonDistributionsTarget,
} from '../../src/index.js';

function target(): WorkspaceCpythonDistributionsTarget {
  return {
    builds: { windowDays: 365 },
    patches: { latest: 1 },
    platforms: ['linux-glibc-x86_64', 'windows-x86_64'],
    provider: 'python-build-standalone',
    series: { from: '3.10', major: 3, through: 'latest-stable' },
    type: 'cpython-distributions',
  };
}

function release(asset: Record<string, unknown>): Record<string, unknown> {
  return {
    assets: [asset],
    draft: false,
    prerelease: false,
    published_at: '2026-08-05T12:00:00.000Z',
    tag_name: '20260805',
  };
}

describe('python-build-standalone discovery', () => {
  it('maps stable install-only assets and uses GitHub SHA-256 digests', async () => {
    const filename =
      'cpython-3.12.13+20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz';
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            release({
              browser_download_url: `https://github.example/releases/${filename}`,
              digest: `sha256:${'a'.repeat(64)}`,
              name: filename,
              size: 34_184_519,
            }),
          ]),
          { headers: { 'content-type': 'application/json' } }
        )
      );

    const candidates = await discoverCpythonDistributionCandidates({
      fetch,
      generatedAt: '2026-08-06T00:00:00.000Z',
      targets: [target()],
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        filename,
        platformFamilyId: 'linux-glibc-x86_64',
        providerBuild: '20260805',
        pythonVersion: '3.12.13',
        sha256: 'a'.repeat(64),
        size: 34_184_519,
      }),
    ]);
  });

  it('falls back to the release SHA256SUMS asset when GitHub omits digests', async () => {
    const filename = 'cpython-3.12.13+20260805-x86_64-pc-windows-msvc-install_only_stripped.tar.gz';
    const checksumUrl = 'https://github.example/releases/SHA256SUMS';
    const fetch: typeof globalThis.fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === checksumUrl) {
        return Promise.resolve(new Response(`${'b'.repeat(64)}  ${filename}\n`));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              ...release({
                browser_download_url: `https://github.example/releases/${filename}`,
                name: filename,
                size: 25_000_000,
              }),
              assets: [
                {
                  browser_download_url: `https://github.example/releases/${filename}`,
                  name: filename,
                  size: 25_000_000,
                },
                {
                  browser_download_url: checksumUrl,
                  name: 'SHA256SUMS',
                  size: 1_000,
                },
              ],
            },
          ])
        )
      );
    };

    const candidates = await discoverCpythonDistributionCandidates({
      fetch,
      generatedAt: '2026-08-06T00:00:00.000Z',
      targets: [target()],
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        filename,
        platformFamilyId: 'windows-x86_64',
        sha256: 'b'.repeat(64),
      }),
    ]);
  });
});
