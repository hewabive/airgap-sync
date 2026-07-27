import catalogData from '../../../support/python/runtime-catalog.json' with { type: 'json' };
import type { BuiltInPlatformFamilyId } from './platform-family.js';

export interface ManagedPythonRuntimeAsset {
  filename: string;
  platformFamilyId: BuiltInPlatformFamilyId;
  pythonVersion: string;
  sha256: string;
  size: number;
  url: string;
}

export interface ManagedPythonRuntimeCatalog {
  assets: ManagedPythonRuntimeAsset[];
  lastReviewedAt: string;
  license: {
    spdx: string;
    url: string;
  };
  provider: string;
  release: string;
  releaseUrl: string;
  schemaVersion: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeManagedPythonRuntimeCatalog(value: unknown): ManagedPythonRuntimeCatalog {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.provider !== 'string' ||
    !value.provider ||
    typeof value.release !== 'string' ||
    !value.release ||
    typeof value.releaseUrl !== 'string' ||
    typeof value.lastReviewedAt !== 'string' ||
    !isRecord(value.license) ||
    typeof value.license.spdx !== 'string' ||
    typeof value.license.url !== 'string' ||
    !Array.isArray(value.assets)
  ) {
    throw new Error('Invalid managed Python runtime catalog');
  }
  const releaseUrl = new URL(value.releaseUrl).toString();
  const licenseUrl = new URL(value.license.url).toString();
  const assets = value.assets.map<ManagedPythonRuntimeAsset>((asset) => {
    if (
      !isRecord(asset) ||
      typeof asset.filename !== 'string' ||
      !asset.filename ||
      asset.filename.includes('/') ||
      asset.filename.includes('\\') ||
      (asset.platformFamilyId !== 'windows-x86_64' &&
        asset.platformFamilyId !== 'linux-glibc-x86_64') ||
      typeof asset.pythonVersion !== 'string' ||
      !/^3\.\d+\.\d+$/u.test(asset.pythonVersion) ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      typeof asset.size !== 'number' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      typeof asset.url !== 'string'
    ) {
      throw new Error('Invalid managed Python runtime catalog asset');
    }
    return {
      filename: asset.filename,
      platformFamilyId: asset.platformFamilyId,
      pythonVersion: asset.pythonVersion,
      sha256: asset.sha256,
      size: asset.size,
      url: new URL(asset.url).toString(),
    };
  });
  const keys = new Set<string>();
  for (const asset of assets) {
    const key = `${asset.pythonVersion}\0${asset.platformFamilyId}`;
    if (keys.has(key)) {
      throw new Error(`Duplicate managed Python runtime asset: ${key.replace('\0', ' / ')}`);
    }
    keys.add(key);
  }
  return {
    assets,
    lastReviewedAt: value.lastReviewedAt,
    license: {
      spdx: value.license.spdx,
      url: licenseUrl,
    },
    provider: value.provider,
    release: value.release,
    releaseUrl,
    schemaVersion: 1,
  };
}

export const managedPythonRuntimeCatalog = normalizeManagedPythonRuntimeCatalog(catalogData);

export function selectManagedPythonRuntimeAsset(
  pythonMinor: string,
  platformFamilyId: BuiltInPlatformFamilyId,
  catalog: ManagedPythonRuntimeCatalog = managedPythonRuntimeCatalog
): ManagedPythonRuntimeAsset | undefined {
  return catalog.assets.find(
    (asset) =>
      asset.pythonVersion.startsWith(`${pythonMinor}.`) &&
      asset.platformFamilyId === platformFamilyId
  );
}
