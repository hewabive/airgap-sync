import path from 'node:path';
import type { GitSource } from '../types.js';

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function gitSourceTargetUrl(source: GitSource, giteaBaseUrl: string): string {
  return `${normalizeBaseUrl(giteaBaseUrl)}/${source.publishOwner ?? source.owner}/${source.publishRepo ?? source.repo}.git`;
}

export function gitSourcePublishOwner(source: GitSource): string {
  return source.publishOwner ?? source.owner;
}

export function gitSourcePublishOwnerKind(source: GitSource): 'organization' | 'user' {
  return source.publishOwnerKind ?? 'organization';
}

export function gitSourcePublishRepo(source: GitSource): string {
  return source.publishRepo ?? source.repo;
}

export function gitSourceMirrorPath(options: {
  bundleDir: string;
  mirrorsDir?: string;
  source: GitSource;
}): string {
  const bundleDir = path.resolve(options.bundleDir);
  if (options.mirrorsDir) {
    return path.join(
      path.resolve(options.mirrorsDir),
      path.relative('git-mirrors', options.source.localMirrorPath)
    );
  }

  return path.join(bundleDir, options.source.localMirrorPath);
}
