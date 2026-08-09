import type { PackageSecurityAdvisoryFinding } from '../types.js';

export type OsvEcosystem = 'npm' | 'PyPI';

export interface OsvPackageQuery {
  ecosystem: OsvEcosystem;
  name: string;
  version: string;
}

export interface OsvVulnerability {
  aliases?: string[];
  id: string;
  modified?: string;
  summary?: string;
}

export interface OsvClient {
  query(packages: OsvPackageQuery[]): Promise<OsvVulnerability[][]>;
}

function packageKey(pkg: OsvPackageQuery): string {
  return [pkg.ecosystem, pkg.name, pkg.version].join('\0');
}

export class OsvBatchClient implements OsvClient {
  readonly #cache = new Map<string, Promise<OsvVulnerability[]>>();

  constructor(
    private readonly url = 'https://api.osv.dev/v1/querybatch',
    private readonly timeoutMs = 30_000
  ) {}

  async query(packages: OsvPackageQuery[]): Promise<OsvVulnerability[][]> {
    const missing = new Map<string, OsvPackageQuery>();
    for (const pkg of packages) {
      const key = packageKey(pkg);
      if (!this.#cache.has(key)) missing.set(key, pkg);
    }

    const pending = [...missing.entries()];
    for (let offset = 0; offset < pending.length; offset += 1000) {
      const batch = pending.slice(offset, offset + 1000);
      const request = this.queryBatch(batch.map(([, pkg]) => pkg));
      for (const [index, [key]] of batch.entries()) {
        this.#cache.set(
          key,
          request.then((results) => results[index] ?? [])
        );
      }
    }

    return Promise.all(packages.map((pkg) => this.#cache.get(packageKey(pkg))!));
  }

  private async queryBatch(packages: OsvPackageQuery[]): Promise<OsvVulnerability[][]> {
    if (packages.length === 0) return [];

    const response = await fetch(this.url, {
      body: JSON.stringify({
        queries: packages.map((pkg) => ({
          package: { ecosystem: pkg.ecosystem, name: pkg.name },
          version: pkg.version,
        })),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`OSV query failed with HTTP ${String(response.status)}`);
    }

    const body = (await response.json()) as {
      results?: { vulns?: OsvVulnerability[] }[];
    };
    if (body.results?.length !== packages.length) {
      throw new Error('OSV returned an incomplete querybatch response');
    }
    return body.results.map((result) => result.vulns ?? []);
  }
}

export function osvFindings(
  packages: { name: string; version: string }[],
  results: OsvVulnerability[][]
): PackageSecurityAdvisoryFinding[] {
  if (results.length !== packages.length) {
    throw new Error('OSV returned an incomplete advisory result set');
  }
  const findings: PackageSecurityAdvisoryFinding[] = [];
  for (const [index, vulnerabilities] of results.entries()) {
    const pkg = packages[index];
    if (!pkg) continue;
    for (const vulnerability of vulnerabilities) {
      const malware = vulnerability.id.startsWith('MAL-');
      findings.push({
        aliases: vulnerability.aliases ?? [],
        id: vulnerability.id,
        ...(vulnerability.modified ? { modified: vulnerability.modified } : {}),
        name: pkg.name,
        severity: malware ? 'error' : 'warning',
        ...(vulnerability.summary ? { summary: vulnerability.summary } : {}),
        type: malware ? 'malware' : 'vulnerability',
        version: pkg.version,
      });
    }
  }
  return findings;
}
