import type { PackageMetadata } from '../types.js';
import { HttpStatusError, isRetryableFetchError, retry } from './retry.js';

const blockedRegistries = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'registry.npmmirror.com',
  'npm.pkg.github.com',
]);

export interface RegistryClient {
  getPackageMetadata(name: string): Promise<PackageMetadata>;
}

export interface HttpRegistryClientOptions {
  authToken?: string;
  retryDelaysMs?: number[];
  timeoutMs?: number;
}

export class CachedRegistryClient implements RegistryClient {
  readonly #cache = new Map<string, Promise<PackageMetadata>>();
  readonly #inner: RegistryClient;

  constructor(inner: RegistryClient) {
    this.#inner = inner;
  }

  getPackageMetadata(name: string): Promise<PackageMetadata> {
    const cached = this.#cache.get(name);
    if (cached) {
      return cached;
    }

    const request = this.#inner.getPackageMetadata(name).catch((error: unknown) => {
      this.#cache.delete(name);
      throw error;
    });
    this.#cache.set(name, request);
    return request;
  }
}

export function encodePackageName(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

export function isBlockedPublishRegistry(registryUrl: string): boolean {
  try {
    const url = new URL(registryUrl);
    return blockedRegistries.has(url.hostname);
  } catch {
    return false;
  }
}

export class HttpRegistryClient implements RegistryClient {
  readonly #registryUrl: string;
  readonly #authToken: string | undefined;
  readonly #retryDelaysMs: number[] | undefined;
  readonly #timeoutMs: number;

  constructor(registryUrl: string, options: HttpRegistryClientOptions = {}) {
    this.#registryUrl = registryUrl.replace(/\/$/, '');
    this.#authToken = options.authToken;
    this.#retryDelaysMs = options.retryDelaysMs;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
  }

  async getPackageMetadata(name: string): Promise<PackageMetadata> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (this.#authToken) {
      headers.Authorization = `Bearer ${this.#authToken}`;
    }

    const response = await retry(
      async () => {
        const metadataResponse = await fetch(`${this.#registryUrl}/${encodePackageName(name)}`, {
          headers,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        if (metadataResponse.status !== 200) {
          throw new HttpStatusError(
            `Registry metadata request failed with status ${String(metadataResponse.status)}`,
            metadataResponse.status
          );
        }

        return metadataResponse;
      },
      {
        ...(this.#retryDelaysMs ? { delaysMs: this.#retryDelaysMs } : {}),
        isRetryable: isRetryableFetchError,
      }
    );

    return (await response.json()) as PackageMetadata;
  }
}
