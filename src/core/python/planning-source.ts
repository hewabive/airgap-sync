import { parseWheelFilename } from './wheels.js';
import { isPrereleaseVersion } from './pep440.js';
import { createServer } from 'node:http';
import { HttpStatusError } from '../retry.js';
import {
  HttpPythonIndexClient,
  MemoizedPythonIndexClient,
  type PythonIndexClient,
  type PythonProjectIndex,
} from './index-client.js';
import { isValidPackageName, normalizePackageName } from './names.js';
import type { PythonResolutionPolicy } from './source-policy.js';
import type { PythonApplicationResolver } from './uv-adapter.js';

/** One immutable, lazily captured project view shared by uv and artifact enumeration. */
export async function createPythonPlanningSource(options: {
  sourceIndex: string;
  resolution: PythonResolutionPolicy;
  cutoff: string;
  resolver: PythonApplicationResolver;
  createClient?: (url: string) => PythonIndexClient;
}) {
  const clients = new Map<string, PythonIndexClient>();
  const projects = new Map<
    string,
    { indexUrl: string; observedAt: string; project: PythonProjectIndex; missingUploadTime: string }
  >();
  const factory = options.createClient ?? ((url: string) => new HttpPythonIndexClient(url));
  function client(url: string): PythonIndexClient {
    let existing = clients.get(url);
    if (!existing) {
      existing = factory(url);
      clients.set(url, existing);
    }
    return existing;
  }
  const index = new MemoizedPythonIndexClient({
    sourceIndex: options.sourceIndex,
    getMetadata: (file, cache) => {
      const entry = [...projects.values()].find((entry) =>
        entry.project.files.some((candidate) => candidate.url === file.url)
      );
      if (!entry) throw new Error(`File is not in the planning snapshot: ${file.url}`);
      return client(entry.indexUrl).getMetadata(file, cache);
    },
    getProject: async (name) => {
      const normalized = normalizePackageName(name);
      const route = options.resolution.packageIndexes?.find((entry) =>
        entry.packages.includes(normalized)
      );
      const indexUrl = route?.indexUrl ?? options.sourceIndex;
      const missingUploadTime = route?.missingUploadTime ?? 'reject';
      const upstream = await client(indexUrl).getProject(normalized);
      const project = {
        ...upstream,
        files: upstream.files.filter(
          (file) =>
            file.yanked === undefined &&
            (options.resolution.prereleasePackages === undefined ||
              options.resolution.prereleasePackages.includes(normalized) ||
              !isPrereleaseVersion(parseWheelFilename(file.filename)?.version ?? '0')) &&
            (file.uploadTime
              ? Date.parse(file.uploadTime) <= Date.parse(options.cutoff)
              : missingUploadTime === 'allow')
        ),
      };
      projects.set(normalized, {
        indexUrl,
        observedAt: new Date().toISOString(),
        project,
        missingUploadTime,
      });
      return project;
    },
  });
  let failure: Error | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      const match = /^\/simple\/([^/]+)\/?$/u.exec(
        new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      );
      if (request.method !== 'GET' || !match || !isValidPackageName(match[1]!)) {
        response.writeHead(404).end();
        return;
      }
      try {
        const project = await index.getProject(match[1]!);
        response.writeHead(200, {
          'Content-Type': 'application/vnd.pypi.simple.v1+json',
          'Cache-Control': 'no-store',
        });
        response.end(
          JSON.stringify({
            meta: { 'api-version': '1.0' },
            name: project.name,
            files: project.files.map((file) => ({
              filename: file.filename,
              url: file.url,
              hashes: file.hashes,
              ...(file.requiresPython ? { 'requires-python': file.requiresPython } : {}),
              ...(file.coreMetadata ? { 'core-metadata': file.coreMetadata } : {}),
              ...(file.size !== undefined ? { size: file.size } : {}),
            })),
          })
        );
      } catch (error) {
        if (error instanceof HttpStatusError && error.status === 404) response.writeHead(404).end();
        else {
          failure ??= error instanceof Error ? error : new Error(String(error));
          response.writeHead(502).end('Upstream index failed');
        }
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot bind planning index');
  const indexUrl = `http://127.0.0.1:${String(address.port)}/simple/`;
  const resolver: PythonApplicationResolver = {
    resolve: async (request) => {
      const filteredRequest = {
        ...request,
        sourceIndex: indexUrl,
        ...(options.resolution.prereleasePackages !== undefined
          ? { prerelease: 'allow' as const }
          : {}),
      };
      // The shared view already applies cutoff; HTML indexes may lack upload times.
      delete filteredRequest.cutoff;
      let result;
      try {
        result = await options.resolver.resolve(filteredRequest);
      } catch (error) {
        throw failure ?? error;
      }
      if (failure) throw failure;
      return result;
    },
  };
  return {
    index,
    resolver,
    snapshot: () => ({
      schemaVersion: 1,
      cutoff: options.cutoff,
      resolution: options.resolution,
      projects: [...projects.values()],
    }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
