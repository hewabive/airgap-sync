import path from 'node:path';
import type { PackageVersionMetadata, RegistryMetadataCacheManifest } from '../types.js';
import * as fs from './fs.js';

const cacheFileName = 'registry-metadata-cache.json';

function packageId(name: string, version: string): string {
  return `${name}@${version}`;
}

function cloneVersionMetadata(metadata: PackageVersionMetadata): PackageVersionMetadata {
  return {
    name: metadata.name,
    version: metadata.version,
    ...(metadata.dependencies ? { dependencies: { ...metadata.dependencies } } : {}),
    dist: { ...metadata.dist },
    ...(metadata.optionalDependencies
      ? { optionalDependencies: { ...metadata.optionalDependencies } }
      : {}),
    ...(metadata.peerDependencies ? { peerDependencies: { ...metadata.peerDependencies } } : {}),
    ...(metadata.peerDependenciesMeta
      ? {
          peerDependenciesMeta: Object.fromEntries(
            Object.entries(metadata.peerDependenciesMeta).map(([name, value]) => [
              name,
              { ...value },
            ])
          ),
        }
      : {}),
    ...(metadata.publishedAt ? { publishedAt: metadata.publishedAt } : {}),
  };
}

export class RegistryMetadataCache {
  readonly #packages = new Map<string, PackageVersionMetadata>();

  constructor(manifest?: RegistryMetadataCacheManifest) {
    for (const value of Object.values(manifest?.packages ?? {})) {
      const metadata = value as Partial<PackageVersionMetadata>;
      if (!metadata.name || !metadata.version || !metadata.dist?.tarball) {
        continue;
      }
      this.set(metadata as PackageVersionMetadata);
    }
  }

  get(name: string, version: string): PackageVersionMetadata | undefined {
    const metadata = this.#packages.get(packageId(name, version));
    return metadata ? cloneVersionMetadata(metadata) : undefined;
  }

  set(metadata: PackageVersionMetadata): void {
    this.#packages.set(packageId(metadata.name, metadata.version), cloneVersionMetadata(metadata));
  }

  toManifest(options: {
    createdAt: string;
    sourceRegistry: string;
  }): RegistryMetadataCacheManifest {
    return {
      schemaVersion: 1,
      createdAt: options.createdAt,
      sourceRegistry: options.sourceRegistry,
      packages: Object.fromEntries(
        [...this.#packages.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, metadata]) => [id, cloneVersionMetadata(metadata)])
      ),
    };
  }
}

export async function readRegistryMetadataCache(bundleDir: string): Promise<RegistryMetadataCache> {
  const filePath = path.join(bundleDir, cacheFileName);
  if (!(await fs.pathExists(filePath))) {
    return new RegistryMetadataCache();
  }

  try {
    return new RegistryMetadataCache(await fs.readJson<RegistryMetadataCacheManifest>(filePath));
  } catch {
    return new RegistryMetadataCache();
  }
}

export async function writeRegistryMetadataCache(
  bundleDir: string,
  cache: RegistryMetadataCache,
  options: { createdAt: string; sourceRegistry: string }
): Promise<void> {
  await fs.writeJson(path.join(bundleDir, cacheFileName), cache.toManifest(options), { spaces: 2 });
}
