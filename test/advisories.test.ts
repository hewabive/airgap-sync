import { afterEach, describe, expect, it, vi } from 'vitest';
import { OsvBatchClient } from '../src/core/advisories.js';
import { OsvPythonAdvisoryClient } from '../src/core/python/security.js';
import { OsvNpmAdvisoryClient } from '../src/core/security.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shared OSV batch client', () => {
  it('queries npm and PyPI with their ecosystem names and reuses exact results', async () => {
    const requests: unknown[] = [];
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') {
        return Promise.reject(new Error('Expected a JSON request body'));
      }
      requests.push(JSON.parse(init.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              { vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }] },
              { vulns: [{ id: 'MAL-2026-1234' }] },
            ],
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new OsvBatchClient('https://osv.example/v1/querybatch');

    await expect(
      client.query([
        { ecosystem: 'npm', name: 'demo-npm', version: '1.0.0' },
        { ecosystem: 'PyPI', name: 'demo-python', version: '2.0.0' },
      ])
    ).resolves.toEqual([[{ id: 'GHSA-aaaa-bbbb-cccc' }], [{ id: 'MAL-2026-1234' }]]);
    await new OsvNpmAdvisoryClient(client).query([{ name: 'demo-npm', version: '1.0.0' }]);
    await new OsvPythonAdvisoryClient(client).query([{ name: 'demo-python', version: '2.0.0' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([
      {
        queries: [
          {
            package: { ecosystem: 'npm', name: 'demo-npm' },
            version: '1.0.0',
          },
          {
            package: { ecosystem: 'PyPI', name: 'demo-python' },
            version: '2.0.0',
          },
        ],
      },
    ]);
  });
});
