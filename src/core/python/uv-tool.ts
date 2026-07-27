import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import * as tar from 'tar';
import * as yauzl from 'yauzl';
import manifestData from '../../../support/python/uv-tool-manifest.json' with { type: 'json' };
import * as fs from '../fs.js';

export interface UvToolAsset {
  file: string;
  sha256: string;
  size: number;
  url: string;
}

export interface UvToolManifest {
  assets: Record<string, UvToolAsset>;
  license: string;
  licenseFiles: {
    name: string;
    sha256: string;
    url: string;
  }[];
  name: 'uv';
  schemaVersion: 1;
  version: string;
}

export interface AcquireUvOptions {
  arch?: NodeJS.Architecture;
  cacheDir: string;
  fetch?: typeof globalThis.fetch;
  platform?: NodeJS.Platform;
  uvBin?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeUvToolManifest(value: unknown): UvToolManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.name !== 'uv' ||
    typeof value.version !== 'string' ||
    typeof value.license !== 'string' ||
    !Array.isArray(value.licenseFiles) ||
    !isRecord(value.assets)
  ) {
    throw new Error('Invalid checked-in uv tool manifest');
  }
  const assets: Record<string, UvToolAsset> = {};
  for (const [key, asset] of Object.entries(value.assets)) {
    if (
      !isRecord(asset) ||
      typeof asset.file !== 'string' ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      typeof asset.size !== 'number' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      typeof asset.url !== 'string'
    ) {
      throw new Error(`Invalid uv tool asset: ${key}`);
    }
    assets[key] = {
      file: asset.file,
      sha256: asset.sha256,
      size: asset.size,
      url: new URL(asset.url).toString(),
    };
  }
  const licenseFiles = value.licenseFiles.map((licenseFile) => {
    if (
      !isRecord(licenseFile) ||
      typeof licenseFile.name !== 'string' ||
      !licenseFile.name ||
      typeof licenseFile.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(licenseFile.sha256) ||
      typeof licenseFile.url !== 'string'
    ) {
      throw new Error('Invalid uv tool license file');
    }
    return {
      name: licenseFile.name,
      sha256: licenseFile.sha256,
      url: new URL(licenseFile.url).toString(),
    };
  });
  return {
    assets,
    license: value.license,
    licenseFiles,
    name: 'uv',
    schemaVersion: 1,
    version: value.version,
  };
}

export const uvToolManifest = normalizeUvToolManifest(manifestData);

export function uvCollectorAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): string {
  const key = `${platform}-${arch}`;
  if (!uvToolManifest.assets[key]) {
    throw new Error(`uv is not available for collector platform ${key}`);
  }
  return key;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function extractZip(file: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        const output = path.resolve(destination, entry.fileName);
        if (!output.startsWith(`${path.resolve(destination)}${path.sep}`)) {
          zip.close();
          reject(new Error(`Unsafe uv zip entry: ${entry.fileName}`));
          return;
        }
        if (entry.fileName.endsWith('/')) {
          void fs.ensureDir(output).then(() => {
            zip.readEntry();
          }, reject);
          return;
        }
        void fs
          .ensureDir(path.dirname(output))
          .then(
            () =>
              new Promise<void>((entryResolve, entryReject) => {
                zip.openReadStream(entry, (streamError, stream) => {
                  if (streamError) {
                    entryReject(streamError);
                    return;
                  }
                  const outputStream = fs.createWriteStream(output);
                  stream.on('error', entryReject);
                  outputStream.on('error', entryReject);
                  outputStream.on('close', entryResolve);
                  stream.pipe(outputStream);
                });
              })
          )
          .then(() => {
            zip.readEntry();
          }, reject);
      });
      zip.readEntry();
    });
  });
}

async function findUvExecutable(root: string, platform: NodeJS.Platform): Promise<string> {
  const expected = platform === 'win32' ? 'uv.exe' : 'uv';
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.name === expected) {
        return candidate;
      }
    }
  }
  throw new Error(`uv archive did not contain ${expected}`);
}

export async function acquireUv(options: AcquireUvOptions): Promise<string> {
  if (options.uvBin) {
    return path.resolve(options.uvBin);
  }
  const platform = options.platform ?? process.platform;
  const key = uvCollectorAssetKey(platform, options.arch ?? process.arch);
  const asset = uvToolManifest.assets[key]!;
  const versionRoot = path.resolve(options.cacheDir, 'uv', uvToolManifest.version, key);
  const executableMarker = path.join(versionRoot, platform === 'win32' ? 'uv.exe.path' : 'uv.path');
  if (await fs.pathExists(executableMarker)) {
    const executable = (await fs.readFile(executableMarker, 'utf8')).trim();
    if (executable && (await fs.pathExists(executable))) {
      return executable;
    }
  }

  const response = await (options.fetch ?? globalThis.fetch)(asset.url, {
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`uv download failed with HTTP ${String(response.status)}: ${asset.url}`);
  }
  const content = new Uint8Array(await response.arrayBuffer());
  if (content.byteLength !== asset.size) {
    throw new Error(
      `uv size mismatch: expected ${String(asset.size)}, received ${String(content.byteLength)}`
    );
  }
  const digest = sha256(content);
  if (digest !== asset.sha256) {
    throw new Error(`uv SHA-256 mismatch: expected ${asset.sha256}, received ${digest}`);
  }

  await fs.remove(versionRoot);
  await fs.ensureDir(versionRoot);
  const archive = path.join(versionRoot, asset.file);
  const extracted = path.join(versionRoot, 'extracted');
  await fs.writeFile(archive, content);
  await fs.ensureDir(extracted);
  if (asset.file.endsWith('.tar.gz')) {
    await tar.x({
      cwd: extracted,
      file: archive,
      preservePaths: false,
      strict: true,
    });
  } else if (asset.file.endsWith('.zip')) {
    await extractZip(archive, extracted);
  } else {
    throw new Error(`Unsupported uv archive format: ${asset.file}`);
  }
  const executable = await findUvExecutable(extracted, platform);
  if (platform !== 'win32') {
    await fs.chmod(executable, 0o755);
  }
  await fs.writeFile(executableMarker, `${executable}\n`);
  return executable;
}
