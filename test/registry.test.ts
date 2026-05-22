import { afterEach, describe, expect, it, vi } from 'vitest';
import { CachedRegistryClient, HttpRegistryClient } from '../src/core/registry.js';
import type { PackageMetadata } from '../src/types.js';
import type { RegistryClient } from '../src/core/registry.js';

const metadata: PackageMetadata = {
  name: 'demo',
  versions: {
    '1.0.0': {
      name: 'demo',
      version: '1.0.0',
      dist: {
        tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
      },
    },
  },
};

describe('CachedRegistryClient', () => {
  it('reuses package metadata requests by package name', async () => {
    let calls = 0;
    const inner: RegistryClient = {
      getPackageMetadata(name) {
        calls++;
        expect(name).toBe('demo');
        return Promise.resolve(metadata);
      },
    };
    const registry = new CachedRegistryClient(inner);

    await expect(registry.getPackageMetadata('demo')).resolves.toBe(metadata);
    await expect(registry.getPackageMetadata('demo')).resolves.toBe(metadata);

    expect(calls).toBe(1);
  });

  it('deduplicates concurrent requests', async () => {
    let calls = 0;
    let resolveRequest: ((value: PackageMetadata) => void) | undefined;
    const inner: RegistryClient = {
      getPackageMetadata() {
        calls++;
        return new Promise<PackageMetadata>((resolve) => {
          resolveRequest = resolve;
        });
      },
    };
    const registry = new CachedRegistryClient(inner);

    const first = registry.getPackageMetadata('demo');
    const second = registry.getPackageMetadata('demo');
    resolveRequest?.(metadata);

    await expect(Promise.all([first, second])).resolves.toEqual([metadata, metadata]);
    expect(calls).toBe(1);
  });

  it('does not cache failed requests', async () => {
    let calls = 0;
    const inner: RegistryClient = {
      getPackageMetadata() {
        calls++;
        if (calls === 1) {
          return Promise.reject(new Error('temporary failure'));
        }
        return Promise.resolve(metadata);
      },
    };
    const registry = new CachedRegistryClient(inner);

    await expect(registry.getPackageMetadata('demo')).rejects.toThrow('temporary failure');
    await expect(registry.getPackageMetadata('demo')).resolves.toBe(metadata);
    expect(calls).toBe(2);
  });
});

describe('HttpRegistryClient', () => {
  const fetchMock = vi.fn<typeof fetch>();

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('retries transient metadata fetch failures', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(new Response('temporary failure', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata), { status: 200 }));

    const registry = new HttpRegistryClient('https://registry.example');

    await expect(registry.getPackageMetadata('demo')).resolves.toEqual(metadata);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry missing package metadata', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response('missing', { status: 404 }));

    const registry = new HttpRegistryClient('https://registry.example');

    await expect(registry.getPackageMetadata('demo')).rejects.toThrow(
      'Registry metadata request failed with status 404'
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
