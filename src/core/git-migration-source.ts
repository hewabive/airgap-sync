import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { gunzip } from 'node:zlib';
import type { GitSource } from '../types.js';
import { gitSourceMirrorPath } from './git-targets.js';

export interface GitMigrationSourceCredentials {
  password: string;
  username: string;
}

export interface GitMigrationSourceServer {
  cloneUrl(source: GitSource): string;
  close(): Promise<void>;
  credentials: GitMigrationSourceCredentials;
}

export interface StartGitMigrationSourceServerOptions {
  advertisedHost?: string;
  bundleDir: string;
  listenHost?: string;
  mirrorsDir?: string;
  port?: number;
  sources: GitSource[];
}

interface ExportedRepository {
  absolutePath: string;
  route: string;
}

const maxCgiHeaderBytes = 64 * 1024;
const maxGitErrorBytes = 12_000;
const maxGitRequestBytes = 32 * 1024 * 1024;

function routeName(source: GitSource, index: number): string {
  const digest = createHash('sha256').update(source.id).digest('hex').slice(0, 20);
  return `${index.toString(36)}-${digest}.git`;
}

function advertisedHostname(host: string): string {
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(unwrapped) === 6) {
    return `[${unwrapped}]`;
  }
  if (
    unwrapped !== host ||
    (isIP(host) !== 4 &&
      (!/^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$/iu.test(host) || host.includes('..')))
  ) {
    throw new Error(`Invalid Git migration advertised host: ${host}`);
  }
  return host;
}

function basicAuthorization(credentials: GitMigrationSourceCredentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

function authorized(request: IncomingMessage, expectedAuthorization: string): boolean {
  const actual = request.headers.authorization;
  if (!actual) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expectedAuthorization);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function cgiHeaderBoundary(buffer: Buffer): { index: number; length: number } | undefined {
  const crlf = buffer.indexOf('\r\n\r\n');
  if (crlf >= 0) {
    return { index: crlf, length: 4 };
  }
  const lf = buffer.indexOf('\n\n');
  return lf >= 0 ? { index: lf, length: 2 } : undefined;
}

function writeCgiHeaders(response: ServerResponse, headerBytes: Buffer): void {
  let status = 200;
  const headers: Record<string, string> = {};
  for (const rawLine of headerBytes.toString('utf8').split(/\r?\n/u)) {
    const separator = rawLine.indexOf(':');
    if (separator < 0) {
      continue;
    }
    const name = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    if (name.toLowerCase() === 'status') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        status = parsed;
      }
    } else {
      headers[name] = value;
    }
  }
  response.writeHead(status, headers);
}

function sendUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="airgap-sync Git migration"',
  });
  response.end('Authentication required\n');
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function runGitHttpBackend(
  request: IncomingMessage,
  response: ServerResponse,
  repository: ExportedRepository,
  requestUrl: URL,
  routeSuffix: string,
  username: string,
  requestBody?: Buffer
): void {
  if (
    requestUrl.searchParams.get('service') === 'git-receive-pack' ||
    routeSuffix === '/git-receive-pack'
  ) {
    response.writeHead(405).end();
    return;
  }

  const child = spawn(
    'git',
    [
      '-c',
      'uploadpack.hideRefs=refs/',
      '-c',
      'uploadpack.hideRefs=!refs/heads/',
      '-c',
      'uploadpack.hideRefs=!refs/tags/',
      'http-backend',
    ],
    {
      env: {
        ...process.env,
        CONTENT_LENGTH:
          requestBody === undefined
            ? headerValue(request.headers['content-length'])
            : String(requestBody.length),
        CONTENT_TYPE: headerValue(request.headers['content-type']),
        GATEWAY_INTERFACE: 'CGI/1.1',
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_PROJECT_ROOT: path.dirname(repository.absolutePath),
        HTTP_GIT_PROTOCOL: headerValue(request.headers['git-protocol']),
        PATH_INFO: `/${path.basename(repository.absolutePath)}${routeSuffix}`,
        QUERY_STRING: requestUrl.search.slice(1),
        REMOTE_ADDR: request.socket.remoteAddress ?? '',
        REMOTE_USER: username,
        REQUEST_METHOD: request.method ?? 'GET',
        SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  let cgiHeaders = Buffer.alloc(0);
  let failed = false;
  let headersWritten = false;
  let stderr = '';

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < maxGitErrorBytes) {
      stderr += chunk.toString('utf8').slice(0, maxGitErrorBytes - stderr.length);
    }
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (failed) {
      return;
    }
    if (headersWritten) {
      response.write(chunk);
      return;
    }
    cgiHeaders = Buffer.concat([cgiHeaders, chunk]);
    if (cgiHeaders.length > maxCgiHeaderBytes) {
      failed = true;
      child.kill();
      response.writeHead(502).end('Invalid Git HTTP response\n');
      return;
    }
    const boundary = cgiHeaderBoundary(cgiHeaders);
    if (!boundary) {
      return;
    }
    writeCgiHeaders(response, cgiHeaders.subarray(0, boundary.index));
    headersWritten = true;
    const body = cgiHeaders.subarray(boundary.index + boundary.length);
    if (body.length > 0 && request.method !== 'HEAD') {
      response.write(body);
    }
    cgiHeaders = Buffer.alloc(0);
  });
  child.stdout.on('end', () => {
    if (failed) {
      return;
    }
    if (!headersWritten) {
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(stderr.trim() || 'Git HTTP backend returned no response\n');
      return;
    }
    response.end();
  });
  child.on('error', (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`${error.message}\n`);
    } else {
      response.destroy(error);
    }
  });

  request.on('aborted', () => {
    child.kill();
  });
  if (requestBody === undefined) {
    request.pipe(child.stdin);
  } else {
    child.stdin.end(requestBody);
  }
}

function serveGitRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repository: ExportedRepository,
  requestUrl: URL,
  routeSuffix: string,
  username: string
): void {
  const contentEncoding = headerValue(request.headers['content-encoding']).toLowerCase();
  if (request.method !== 'POST') {
    runGitHttpBackend(request, response, repository, requestUrl, routeSuffix, username);
    return;
  }
  if (contentEncoding !== '' && contentEncoding !== 'identity' && contentEncoding !== 'gzip') {
    response.writeHead(415).end('Unsupported Git request encoding\n');
    return;
  }

  const declaredLength = Number.parseInt(headerValue(request.headers['content-length']), 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxGitRequestBytes) {
    response.writeHead(413).end();
    request.destroy();
    return;
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  request.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxGitRequestBytes) {
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (bytes > maxGitRequestBytes) {
      return;
    }
    const body = Buffer.concat(chunks);
    if (contentEncoding !== 'gzip') {
      runGitHttpBackend(request, response, repository, requestUrl, routeSuffix, username, body);
      return;
    }
    gunzip(body, { maxOutputLength: maxGitRequestBytes }, (error, decompressedBody) => {
      if (error) {
        response.writeHead(400).end('Invalid compressed Git request\n');
        return;
      }
      runGitHttpBackend(
        request,
        response,
        repository,
        requestUrl,
        routeSuffix,
        username,
        decompressedBody
      );
    });
  });
  request.on('error', (error) => {
    if (!response.headersSent) {
      response.writeHead(400).end(`${error.message}\n`);
    }
  });
}

export async function startGitMigrationSourceServer(
  options: StartGitMigrationSourceServerOptions
): Promise<GitMigrationSourceServer> {
  const listenHost = options.listenHost ?? '127.0.0.1';
  const advertisedHost = advertisedHostname(options.advertisedHost ?? listenHost);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid Git migration server port: ${String(port)}`);
  }
  const credentials: GitMigrationSourceCredentials = {
    password: randomBytes(24).toString('base64url'),
    username: 'airgap-sync',
  };
  const expectedAuthorization = basicAuthorization(credentials);
  const repositoriesByRoute = new Map<string, ExportedRepository>();
  const routesBySource = new Map<string, string>();
  for (const [index, source] of options.sources.entries()) {
    if (routesBySource.has(source.id)) {
      throw new Error(`Duplicate Git migration source: ${source.id}`);
    }
    const route = `/repositories/${routeName(source, index)}`;
    repositoriesByRoute.set(route, {
      absolutePath: gitSourceMirrorPath({
        bundleDir: options.bundleDir,
        ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
        source,
      }),
      route,
    });
    routesBySource.set(source.id, route);
  }

  const server = createServer((request, response) => {
    if (!authorized(request, expectedAuthorization)) {
      sendUnauthorized(response);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let requestUrl: URL;
    let pathname: string;
    try {
      requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const route = /^(\/repositories\/[a-z0-9-]+\.git)(?:\/|$)/u.exec(pathname)?.[1];
    const repository = route ? repositoriesByRoute.get(route) : undefined;
    if (!repository) {
      response.writeHead(404).end();
      return;
    }
    const routeSuffix = pathname.slice(repository.route.length);
    const isInfoRefs =
      routeSuffix === '/info/refs' &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      requestUrl.searchParams.get('service') === 'git-upload-pack';
    const isUploadPack = routeSuffix === '/git-upload-pack' && request.method === 'POST';
    if (!isInfoRefs && !isUploadPack) {
      response.writeHead(405).end();
      return;
    }
    serveGitRequest(request, response, repository, requestUrl, routeSuffix, credentials.username);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, listenHost, () => {
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
    throw new Error('Temporary Git migration source did not receive a TCP address');
  }
  const baseUrl = `http://${advertisedHost}:${String(address.port)}`;

  return {
    cloneUrl(source: GitSource): string {
      const route = routesBySource.get(source.id);
      if (!route) {
        throw new Error(`Git migration source is not exported: ${source.id}`);
      }
      return `${baseUrl}${route}`;
    },
    close: async () => {
      server.closeIdleConnections();
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
    credentials,
  };
}
