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

function release(
  asset: Record<string, unknown>,
  options: { publishedAt?: string; tag?: string } = {}
): Record<string, unknown> {
  return {
    assets: [asset],
    draft: false,
    prerelease: false,
    published_at: options.publishedAt ?? '2026-08-05T12:00:00.000Z',
    tag_name: options.tag ?? '20260805',
  };
}

function releaseWithDigest(
  pythonVersion: string,
  tag: string,
  publishedAt: string
): Record<string, unknown> {
  const filename = `cpython-${pythonVersion}+${tag}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`;
  return release(
    {
      browser_download_url: `https://github.example/releases/${tag}/${filename}`,
      digest: `sha256:${tag.padEnd(64, 'a')}`,
      name: filename,
      size: 34_184_519,
    },
    { publishedAt, tag }
  );
}

describe('python-build-standalone discovery', () => {
  it('maps stable install-only assets and uses GitHub SHA-256 digests', async () => {
    const filename =
      'cpython-3.12.13+20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz';
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      urls.push(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(
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
    };

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
    expect(urls).toEqual([
      'https://api.github.com/repos/astral-sh/python-build-standalone/releases?per_page=10&page=1',
    ]);
  });

  it('retries transient GitHub failures and reports retry progress', async () => {
    let attempts = 0;
    const retries: { attempt: number; delayMs: number; page?: number; phase: string }[] = [];
    const fetch: typeof globalThis.fetch = () => {
      attempts++;
      return Promise.resolve(
        attempts === 1
          ? new Response('temporary gateway failure', { status: 504 })
          : new Response(
              JSON.stringify([releaseWithDigest('3.12.13', '20260805', '2026-08-05T12:00:00.000Z')])
            )
      );
    };

    const candidates = await discoverCpythonDistributionCandidates({
      fetch,
      generatedAt: '2026-08-06T00:00:00.000Z',
      onRetry: (event) => {
        retries.push({
          attempt: event.attempt,
          delayMs: event.delayMs,
          ...(event.page !== undefined ? { page: event.page } : {}),
          phase: event.phase,
        });
      },
      retryDelaysMs: [0],
      targets: [target()],
    });

    expect(attempts).toBe(2);
    expect(retries).toEqual([{ attempt: 1, delayMs: 0, page: 1, phase: 'releases' }]);
    expect(candidates).toHaveLength(1);
  });

  it('fails after the configured transient retry budget is exhausted', async () => {
    let attempts = 0;
    const fetch: typeof globalThis.fetch = () => {
      attempts++;
      return Promise.resolve(new Response('temporary gateway failure', { status: 504 }));
    };

    await expect(
      discoverCpythonDistributionCandidates({
        fetch,
        generatedAt: '2026-08-06T00:00:00.000Z',
        retryDelaysMs: [0, 0],
        targets: [target()],
      })
    ).rejects.toThrow('Unable to list python-build-standalone releases: HTTP 504');
    expect(attempts).toBe(3);
  });

  it('paginates with the configured small page size and stops on a short page', async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      urls.push(url);
      const page = new URL(url).searchParams.get('page');
      return Promise.resolve(
        new Response(
          JSON.stringify(
            page === '1'
              ? [
                  releaseWithDigest('3.13.5', '20260805', '2026-08-05T12:00:00.000Z'),
                  releaseWithDigest('3.12.13', '20260801', '2026-08-01T12:00:00.000Z'),
                ]
              : [releaseWithDigest('3.11.9', '20240101', '2024-01-01T12:00:00.000Z')]
          )
        )
      );
    };

    const candidates = await discoverCpythonDistributionCandidates({
      fetch,
      generatedAt: '2026-08-06T00:00:00.000Z',
      pageSize: 2,
      targets: [target()],
    });

    expect(urls).toEqual([
      'https://api.github.com/repos/astral-sh/python-build-standalone/releases?per_page=2&page=1',
      'https://api.github.com/repos/astral-sh/python-build-standalone/releases?per_page=2&page=2',
    ]);
    expect(candidates.map((candidate) => candidate.pythonVersion)).toEqual([
      '3.13.5',
      '3.12.13',
      '3.11.9',
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
