import { createServer } from 'node:http';
import path from 'node:path';
import * as fs from '../fs.js';
import type { PythonSeedFile, PythonSeedManifest } from './bundle.js';
import { normalizePackageName } from './names.js';

export interface PythonBundleIndexServer {
  close(): Promise<void>;
  indexUrl: string;
}

interface ServedFile {
  absolutePath: string;
  file: PythonSeedFile;
}

function html(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function safeBundleFile(bundleDir: string, relativeFile: string): string {
  if (
    path.posix.isAbsolute(relativeFile) ||
    relativeFile.includes('\\') ||
    relativeFile.split('/').includes('..')
  ) {
    throw new Error(`Unsafe Python bundle index file path: ${relativeFile}`);
  }
  const absolute = path.resolve(bundleDir, relativeFile);
  const relative = path.relative(bundleDir, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Python bundle index file escapes the bundle: ${relativeFile}`);
  }
  return absolute;
}

export async function startPythonBundleIndexServer(
  bundleDir: string,
  manifest: PythonSeedManifest
): Promise<PythonBundleIndexServer> {
  const projects = new Map<string, ServedFile[]>();
  const files = new Map<string, ServedFile>();
  for (const pkg of manifest.packages) {
    const name = normalizePackageName(pkg.name);
    const projectFiles = projects.get(name) ?? [];
    for (const file of pkg.files) {
      const served = {
        absolutePath: safeBundleFile(bundleDir, file.file),
        file,
      };
      const filePath = `/files/${file.sha256}/${encodeURIComponent(file.filename)}`;
      files.set(filePath, served);
      projectFiles.push(served);
    }
    projects.set(name, projectFiles);
  }

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    if (requestUrl.pathname === '/simple/' || requestUrl.pathname === '/simple') {
      const body = `${[...projects.keys()]
        .sort()
        .map((name) => `<a href="${encodeURIComponent(name)}/">${html(name)}</a>`)
        .join('\n')}\n`;
      response.writeHead(200, {
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'application/vnd.pypi.simple.v1+html; charset=utf-8',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    const projectMatch = /^\/simple\/([^/]+)\/?$/u.exec(requestUrl.pathname);
    if (projectMatch) {
      const name = normalizePackageName(decodeURIComponent(projectMatch[1]!));
      const projectFiles = projects.get(name);
      if (!projectFiles) {
        response.writeHead(404).end();
        return;
      }
      const body = `${projectFiles
        .map(({ file }) => {
          const requiresPython = file.coreMetadata.requiresPython;
          return `<a href="/files/${file.sha256}/${encodeURIComponent(file.filename)}#sha256=${file.sha256}"${
            requiresPython ? ` data-requires-python="${html(requiresPython)}"` : ''
          }>${html(file.filename)}</a>`;
        })
        .join('\n')}\n`;
      response.writeHead(200, {
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'application/vnd.pypi.simple.v1+html; charset=utf-8',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    const served = files.get(requestUrl.pathname);
    if (!served) {
      response.writeHead(404).end();
      return;
    }
    void fs
      .stat(served.absolutePath)
      .then((stat) => {
        response.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': 'application/octet-stream',
        });
        if (request.method === 'HEAD') {
          response.end();
        } else {
          fs.createReadStream(served.absolutePath).pipe(response);
        }
      })
      .catch(() => response.writeHead(404).end());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    throw new Error('Temporary Python bundle index did not receive a TCP address');
  }
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
    indexUrl: `http://127.0.0.1:${String(address.port)}/simple/`,
  };
}
