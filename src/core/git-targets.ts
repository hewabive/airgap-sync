import path from 'node:path';
import type { GitSource } from '../types.js';

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function gitSourceTargetUrl(source: GitSource, giteaBaseUrl: string): string {
  return `${normalizeBaseUrl(giteaBaseUrl)}/${source.owner}/${source.repo}.git`;
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
