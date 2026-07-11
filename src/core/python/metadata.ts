import { createHash } from 'node:crypto';
import path from 'node:path';
import * as fs from '../fs.js';

export interface PythonCoreMetadata {
  author?: string;
  authorEmail?: string;
  description?: string;
  descriptionContentType?: string;
  homePage?: string;
  license?: string;
  metadataVersion: string;
  name: string;
  projectUrls: string[];
  providesExtra: string[];
  requiresDist: string[];
  requiresPython?: string;
  summary?: string;
  version: string;
}

export interface PythonArtifactIdentity {
  hashes: Record<string, string>;
  sourceIndex: string;
  url: string;
}

export interface PythonMetadataCacheEntry extends PythonArtifactIdentity {
  metadata: PythonCoreMetadata;
}

export interface PythonMetadataCacheManifest {
  schemaVersion: 1;
  createdAt: string;
  sourceIndex: string;
  entries: Record<string, PythonMetadataCacheEntry>;
}

const cacheFileName = 'python-metadata-cache.json';

function splitMetadata(text: string): { body: string; headerBlock: string } {
  const separator = /\r?\n\r?\n/.exec(text);
  if (!separator) {
    return { body: '', headerBlock: text };
  }

  return {
    body: text.slice(separator.index + separator[0].length),
    headerBlock: text.slice(0, separator.index),
  };
}

function unfoldHeaderLines(headerBlock: string): string[] {
  const lines: string[] = [];

  for (const line of headerBlock.split(/\r?\n/)) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (lines.length === 0) {
        continue;
      }
      const previous = lines.at(-1)!;
      lines[lines.length - 1] = `${previous} ${line.trim()}`;
      continue;
    }
    lines.push(line);
  }

  return lines;
}

export function parseCoreMetadata(text: string): PythonCoreMetadata {
  const { body, headerBlock } = splitMetadata(text);
  const headers = new Map<string, string[]>();

  for (const line of unfoldHeaderLines(headerBlock)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const existing = headers.get(key);
    if (existing) {
      existing.push(value);
    } else {
      headers.set(key, [value]);
    }
  }

  const single = (key: string): string | undefined => headers.get(key)?.[0];
  const metadataVersion = single('metadata-version');
  const name = single('name');
  const version = single('version');

  if (!metadataVersion || !name || !version) {
    throw new Error('Core metadata is missing Metadata-Version, Name, or Version');
  }
  if (!/^\d+\.\d+$/.test(metadataVersion)) {
    throw new Error(`Core metadata has invalid Metadata-Version: ${metadataVersion}`);
  }

  const optionalFields = {
    author: single('author'),
    authorEmail: single('author-email'),
    descriptionContentType: single('description-content-type'),
    homePage: single('home-page'),
    license: single('license'),
    requiresPython: single('requires-python'),
    summary: single('summary'),
  };
  const headerDescription = single('description');
  const description = body.trim() || headerDescription;

  return {
    metadataVersion,
    name,
    projectUrls: headers.get('project-url') ?? [],
    providesExtra: headers.get('provides-extra') ?? [],
    requiresDist: headers.get('requires-dist') ?? [],
    version,
    ...(optionalFields.author !== undefined ? { author: optionalFields.author } : {}),
    ...(optionalFields.authorEmail !== undefined
      ? { authorEmail: optionalFields.authorEmail }
      : {}),
    ...(description !== undefined ? { description } : {}),
    ...(optionalFields.descriptionContentType !== undefined
      ? { descriptionContentType: optionalFields.descriptionContentType }
      : {}),
    ...(optionalFields.homePage !== undefined ? { homePage: optionalFields.homePage } : {}),
    ...(optionalFields.license !== undefined ? { license: optionalFields.license } : {}),
    ...(optionalFields.requiresPython !== undefined
      ? { requiresPython: optionalFields.requiresPython }
      : {}),
    ...(optionalFields.summary !== undefined ? { summary: optionalFields.summary } : {}),
  };
}

function cloneCoreMetadata(metadata: PythonCoreMetadata): PythonCoreMetadata {
  return {
    metadataVersion: metadata.metadataVersion,
    name: metadata.name,
    projectUrls: [...metadata.projectUrls],
    providesExtra: [...metadata.providesExtra],
    requiresDist: [...metadata.requiresDist],
    version: metadata.version,
    ...(metadata.author !== undefined ? { author: metadata.author } : {}),
    ...(metadata.authorEmail !== undefined ? { authorEmail: metadata.authorEmail } : {}),
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(metadata.descriptionContentType !== undefined
      ? { descriptionContentType: metadata.descriptionContentType }
      : {}),
    ...(metadata.homePage !== undefined ? { homePage: metadata.homePage } : {}),
    ...(metadata.license !== undefined ? { license: metadata.license } : {}),
    ...(metadata.requiresPython !== undefined ? { requiresPython: metadata.requiresPython } : {}),
    ...(metadata.summary !== undefined ? { summary: metadata.summary } : {}),
  };
}

function cloneHashes(hashes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))
  );
}

function artifactId(identity: PythonArtifactIdentity): string {
  const canonical = JSON.stringify({
    hashes: cloneHashes(identity.hashes),
    sourceIndex: identity.sourceIndex,
    url: identity.url,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function cloneEntry(entry: PythonMetadataCacheEntry): PythonMetadataCacheEntry {
  return {
    hashes: cloneHashes(entry.hashes),
    metadata: cloneCoreMetadata(entry.metadata),
    sourceIndex: entry.sourceIndex,
    url: entry.url,
  };
}

function validMetadata(value: unknown): value is PythonCoreMetadata {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const metadata = value as Partial<PythonCoreMetadata>;
  return Boolean(metadata.metadataVersion && metadata.name && metadata.version);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class PythonMetadataCache {
  readonly #entries = new Map<string, PythonMetadataCacheEntry>();

  constructor(manifest?: Partial<PythonMetadataCacheManifest>) {
    if (manifest?.schemaVersion !== 1) {
      return;
    }

    const entries: unknown = manifest.entries;
    if (!isRecord(entries)) {
      return;
    }
    for (const value of Object.values(entries)) {
      if (
        !isRecord(value) ||
        typeof value.sourceIndex !== 'string' ||
        typeof value.url !== 'string' ||
        !isRecord(value.hashes) ||
        !validMetadata(value.metadata)
      ) {
        continue;
      }
      this.set(
        {
          hashes: normalizeHashRecord(value.hashes),
          sourceIndex: value.sourceIndex,
          url: value.url,
        },
        value.metadata
      );
    }
  }

  get(identity: PythonArtifactIdentity): PythonCoreMetadata | undefined {
    const entry = this.#entries.get(artifactId(identity));
    return entry ? cloneCoreMetadata(entry.metadata) : undefined;
  }

  set(identity: PythonArtifactIdentity, metadata: PythonCoreMetadata): void {
    const entry: PythonMetadataCacheEntry = {
      hashes: cloneHashes(identity.hashes),
      metadata: cloneCoreMetadata(metadata),
      sourceIndex: identity.sourceIndex,
      url: identity.url,
    };
    this.#entries.set(artifactId(identity), entry);
  }

  toManifest(options: { createdAt: string; sourceIndex: string }): PythonMetadataCacheManifest {
    return {
      schemaVersion: 1,
      createdAt: options.createdAt,
      sourceIndex: options.sourceIndex,
      entries: Object.fromEntries(
        [...this.#entries.entries()]
          .filter(([, entry]) => entry.sourceIndex === options.sourceIndex)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, entry]) => [id, cloneEntry(entry)])
      ),
    };
  }
}

function normalizeHashRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

export async function readPythonMetadataCache(
  bundleDir: string,
  sourceIndex: string
): Promise<PythonMetadataCache> {
  const filePath = path.join(bundleDir, cacheFileName);
  if (!(await fs.pathExists(filePath))) {
    return new PythonMetadataCache();
  }

  try {
    const manifest = await fs.readJson<PythonMetadataCacheManifest>(filePath);
    return manifest.sourceIndex === sourceIndex
      ? new PythonMetadataCache(manifest)
      : new PythonMetadataCache();
  } catch {
    return new PythonMetadataCache();
  }
}

export async function writePythonMetadataCache(
  bundleDir: string,
  cache: PythonMetadataCache,
  options: { createdAt: string; sourceIndex: string }
): Promise<void> {
  await fs.writeJson(path.join(bundleDir, cacheFileName), cache.toManifest(options), { spaces: 2 });
}
