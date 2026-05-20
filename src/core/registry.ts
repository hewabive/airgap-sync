import axios from 'axios';
import type { PackageMetadata } from '../types.js';

export interface RegistryClient {
  getPackageMetadata(name: string): Promise<PackageMetadata>;
}

export interface HttpRegistryClientOptions {
  authToken?: string;
  timeoutMs?: number;
}

function encodePackageName(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

export class HttpRegistryClient implements RegistryClient {
  readonly #registryUrl: string;
  readonly #authToken: string | undefined;
  readonly #timeoutMs: number;

  constructor(registryUrl: string, options: HttpRegistryClientOptions = {}) {
    this.#registryUrl = registryUrl.replace(/\/$/, '');
    this.#authToken = options.authToken;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async getPackageMetadata(name: string): Promise<PackageMetadata> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (this.#authToken) {
      headers.Authorization = `Bearer ${this.#authToken}`;
    }

    const response = await axios.get<PackageMetadata>(
      `${this.#registryUrl}/${encodePackageName(name)}`,
      {
        headers,
        timeout: this.#timeoutMs,
        validateStatus: (status) => status === 200,
      }
    );

    return response.data;
  }
}
