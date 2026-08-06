import type { WorkspaceCpythonDistributionsTarget } from '../workspace.js';
import { HttpStatusError, isRetryableFetchError, retry, type RetryEvent } from '../retry.js';
import type { CpythonDistributionCandidate } from './distribution-selection.js';
import type { BuiltInPlatformFamilyId } from './platform-family.js';

interface GithubReleaseAsset {
  browser_download_url: string;
  digest?: string | null;
  name: string;
  size: number;
}

interface GithubRelease {
  assets: GithubReleaseAsset[];
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  tag_name: string;
}

interface PendingCandidate extends Omit<CpythonDistributionCandidate, 'sha256'> {
  release: GithubRelease;
  sha256?: string;
}

export interface DiscoverCpythonDistributionCandidatesOptions {
  fetch?: typeof globalThis.fetch;
  generatedAt?: string;
  githubApiBaseUrl?: string;
  maxPages?: number;
  onPage?: (event: { candidates: number; page: number; releases: number }) => void;
  onRetry?: (event: CpythonDistributionDiscoveryRetryEvent) => void;
  pageSize?: number;
  requestTimeoutMs?: number;
  retryDelaysMs?: number[];
  targets: WorkspaceCpythonDistributionsTarget[];
}

export interface CpythonDistributionDiscoveryRetryEvent extends RetryEvent {
  page?: number;
  phase: 'checksums' | 'releases';
  url: string;
}

interface ProviderFetchOptions {
  failureMessage: string;
  fetchImplementation: typeof globalThis.fetch;
  onRetry?: (event: CpythonDistributionDiscoveryRetryEvent) => void;
  page?: number;
  phase: CpythonDistributionDiscoveryRetryEvent['phase'];
  requestTimeoutMs: number;
  retryDelaysMs?: number[];
  url: string;
}

const defaultGithubReleasesPageSize = 10;

const releaseAssetPattern =
  /^cpython-(\d+\.\d+\.\d+)\+(\d{8})-x86_64-(unknown-linux-gnu|pc-windows-msvc)-install_only_stripped\.tar\.gz$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeGithubAsset(value: unknown): GithubReleaseAsset {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.browser_download_url !== 'string' ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) <= 0 ||
    (value.digest !== undefined && value.digest !== null && typeof value.digest !== 'string')
  ) {
    throw new Error('Invalid python-build-standalone GitHub release asset');
  }
  return {
    browser_download_url: new URL(value.browser_download_url).toString(),
    ...(typeof value.digest === 'string' ? { digest: value.digest } : {}),
    name: value.name,
    size: value.size as number,
  };
}

function normalizeGithubRelease(value: unknown): GithubRelease {
  if (
    !isRecord(value) ||
    typeof value.tag_name !== 'string' ||
    typeof value.published_at !== 'string' ||
    typeof value.draft !== 'boolean' ||
    typeof value.prerelease !== 'boolean' ||
    !Array.isArray(value.assets)
  ) {
    throw new Error('Invalid python-build-standalone GitHub release');
  }
  const published = new Date(value.published_at);
  if (!Number.isFinite(published.getTime())) {
    throw new Error('Invalid python-build-standalone release publication time');
  }
  return {
    assets: value.assets.map(normalizeGithubAsset),
    draft: value.draft,
    prerelease: value.prerelease,
    published_at: published.toISOString(),
    tag_name: value.tag_name,
  };
}

function platformFamilyId(target: string): BuiltInPlatformFamilyId {
  return target === 'unknown-linux-gnu' ? 'linux-glibc-x86_64' : 'windows-x86_64';
}

function sha256Digest(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^sha256:([a-f0-9]{64})$/u.exec(value);
  return match?.[1];
}

function releaseCandidates(
  release: GithubRelease,
  requestedPlatforms: Set<BuiltInPlatformFamilyId>,
  minimumMinor: number
): PendingCandidate[] {
  if (release.draft || release.prerelease) return [];
  const candidates: PendingCandidate[] = [];
  for (const asset of release.assets) {
    const match = releaseAssetPattern.exec(asset.name);
    if (!match) continue;
    const pythonVersion = match[1]!;
    const providerBuild = match[2]!;
    const platform = platformFamilyId(match[3]!);
    const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(pythonVersion)!;
    if (
      Number(version[1]) !== 3 ||
      Number(version[2]) < minimumMinor ||
      !requestedPlatforms.has(platform)
    ) {
      continue;
    }
    if (providerBuild !== release.tag_name) {
      throw new Error(
        `python-build-standalone asset build ${providerBuild} does not match release ${release.tag_name}`
      );
    }
    const sha256 = sha256Digest(asset.digest);
    candidates.push({
      filename: asset.name,
      platformFamilyId: platform,
      provider: 'python-build-standalone',
      providerBuild,
      providerPublishedAt: release.published_at,
      pythonVersion,
      release,
      ...(sha256 ? { sha256 } : {}),
      size: asset.size,
      sourceUrl: asset.browser_download_url,
    });
  }
  return candidates;
}

function enoughPatchHistory(
  candidates: PendingCandidate[],
  targets: WorkspaceCpythonDistributionsTarget[]
): boolean {
  return targets.every((target) =>
    target.platforms.every((platform) => {
      const matching = candidates.filter((candidate) => {
        const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(candidate.pythonVersion)!;
        return (
          candidate.platformFamilyId === platform &&
          Number(version[2]) >= Number(target.series.from.split('.')[1])
        );
      });
      const byMinor = new Map<number, Set<number>>();
      for (const candidate of matching) {
        const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(candidate.pythonVersion)!;
        const minor = Number(version[2]);
        const patches = byMinor.get(minor) ?? new Set<number>();
        patches.add(Number(version[3]));
        byMinor.set(minor, patches);
      }
      if (byMinor.size === 0) return true;
      return [...byMinor.values()].every(
        (patches) => patches.size >= target.patches.latest || patches.has(0)
      );
    })
  );
}

function parseChecksums(content: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of content.split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})\s+[* ]?(.+)$/u.exec(line.trim());
    if (match) checksums.set(match[2]!, match[1]!);
  }
  return checksums;
}

function retryAfterMilliseconds(response: Response, now = Date.now()): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1_000);
    }
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) {
      return Math.max(0, timestamp - now);
    }
  }
  if (
    (response.status === 403 || response.status === 429) &&
    response.headers.get('x-ratelimit-remaining') === '0'
  ) {
    const resetSeconds = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
      return Math.max(0, Math.ceil(resetSeconds * 1_000 - now));
    }
  }
  return undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The original HTTP status is more useful than a body cleanup failure.
  }
}

async function fetchProviderBody<T>(
  options: ProviderFetchOptions,
  accept: string,
  read: (response: Response) => Promise<T>
): Promise<T> {
  return retry(
    async () => {
      const response = await options.fetchImplementation(options.url, {
        headers: {
          Accept: accept,
          'User-Agent': 'airgap-sync',
          ...(options.phase === 'releases' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
        },
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
      if (!response.ok) {
        const retryAfterMs = retryAfterMilliseconds(response);
        await cancelResponseBody(response);
        throw new HttpStatusError(
          `${options.failureMessage}: HTTP ${String(response.status)}`,
          response.status,
          retryAfterMs
        );
      }
      return read(response);
    },
    {
      ...(options.retryDelaysMs ? { delaysMs: options.retryDelaysMs } : {}),
      isRetryable: isRetryableFetchError,
      onRetry: (event) => {
        options.onRetry?.({
          ...event,
          ...(options.page !== undefined ? { page: options.page } : {}),
          phase: options.phase,
          url: options.url,
        });
      },
    }
  );
}

async function fetchText(options: ProviderFetchOptions): Promise<string> {
  return fetchProviderBody(options, 'application/octet-stream', (response) => response.text());
}

async function fetchJson(options: ProviderFetchOptions): Promise<unknown> {
  return fetchProviderBody(options, 'application/vnd.github+json', (response) => response.json());
}

async function fillMissingDigests(
  candidates: PendingCandidate[],
  options: Pick<DiscoverCpythonDistributionCandidatesOptions, 'onRetry' | 'retryDelaysMs'> & {
    fetchImplementation: typeof globalThis.fetch;
    requestTimeoutMs: number;
  }
): Promise<void> {
  const releases = new Map<string, PendingCandidate[]>();
  for (const candidate of candidates.filter((item) => !item.sha256)) {
    const current = releases.get(candidate.release.tag_name) ?? [];
    current.push(candidate);
    releases.set(candidate.release.tag_name, current);
  }
  for (const pending of releases.values()) {
    const release = pending[0]!.release;
    const checksumAsset = release.assets.find((asset) => asset.name === 'SHA256SUMS');
    if (!checksumAsset) {
      throw new Error(`python-build-standalone ${release.tag_name} has no SHA256SUMS asset`);
    }
    const checksums = parseChecksums(
      await fetchText({
        failureMessage: `Unable to fetch python-build-standalone ${release.tag_name} checksums`,
        fetchImplementation: options.fetchImplementation,
        ...(options.onRetry ? { onRetry: options.onRetry } : {}),
        phase: 'checksums',
        requestTimeoutMs: options.requestTimeoutMs,
        ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
        url: checksumAsset.browser_download_url,
      })
    );
    for (const candidate of pending) {
      const sha256 = checksums.get(candidate.filename);
      if (!sha256) {
        throw new Error(
          `python-build-standalone ${release.tag_name} checksum is missing for ${candidate.filename}`
        );
      }
      candidate.sha256 = sha256;
    }
  }
}

export async function discoverCpythonDistributionCandidates(
  options: DiscoverCpythonDistributionCandidatesOptions
): Promise<CpythonDistributionCandidate[]> {
  if (options.targets.length === 0) return [];
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const generatedAt = new Date(options.generatedAt ?? new Date().toISOString());
  if (!Number.isFinite(generatedAt.getTime())) {
    throw new Error('CPython distribution generatedAt must be an ISO timestamp');
  }
  const requestedPlatforms = new Set(options.targets.flatMap((target) => target.platforms));
  const minimumMinor = Math.min(
    ...options.targets.map((target) => Number(target.series.from.split('.')[1]))
  );
  const maximumWindowDays = Math.max(...options.targets.map((target) => target.builds.windowDays));
  const cutoff = generatedAt.getTime() - maximumWindowDays * 24 * 60 * 60 * 1000;
  const apiBaseUrl = (options.githubApiBaseUrl ?? 'https://api.github.com').replace(/\/+$/u, '');
  const timeoutMs = options.requestTimeoutMs ?? 60_000;
  const candidates: PendingCandidate[] = [];
  const maxPages = options.maxPages ?? 20;
  const pageSize = options.pageSize ?? defaultGithubReleasesPageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('CPython distribution GitHub pageSize must be between 1 and 100');
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error('CPython distribution maxPages must be a positive integer');
  }

  for (let page = 1; page <= maxPages; page++) {
    const url = `${apiBaseUrl}/repos/astral-sh/python-build-standalone/releases?per_page=${String(pageSize)}&page=${String(page)}`;
    const value = await fetchJson({
      failureMessage: 'Unable to list python-build-standalone releases',
      fetchImplementation,
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
      page,
      phase: 'releases',
      requestTimeoutMs: timeoutMs,
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      url,
    });
    if (!Array.isArray(value)) {
      throw new Error('Invalid python-build-standalone GitHub releases response');
    }
    const releases = value.map(normalizeGithubRelease);
    for (const release of releases) {
      candidates.push(...releaseCandidates(release, requestedPlatforms, minimumMinor));
    }
    options.onPage?.({ candidates: candidates.length, page, releases: releases.length });
    if (releases.length === 0) break;
    const oldest = releases.at(-1)!;
    if (
      new Date(oldest.published_at).getTime() < cutoff &&
      enoughPatchHistory(candidates, options.targets)
    ) {
      break;
    }
    if (releases.length < pageSize) break;
    if (page === maxPages) {
      throw new Error(
        `python-build-standalone release discovery exceeded ${String(maxPages)} pages`
      );
    }
  }

  await fillMissingDigests(candidates, {
    fetchImplementation,
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    requestTimeoutMs: timeoutMs,
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
  });
  const deduplicated = new Map<string, CpythonDistributionCandidate>();
  for (const candidate of candidates) {
    deduplicated.set(candidate.sourceUrl, {
      filename: candidate.filename,
      platformFamilyId: candidate.platformFamilyId,
      provider: candidate.provider,
      providerBuild: candidate.providerBuild,
      providerPublishedAt: candidate.providerPublishedAt,
      pythonVersion: candidate.pythonVersion,
      sha256: candidate.sha256!,
      size: candidate.size,
      sourceUrl: candidate.sourceUrl,
    });
  }
  return [...deduplicated.values()];
}
