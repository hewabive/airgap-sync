import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpPythonIndexClient, type PythonIndexFile } from '../../src/core/python/index-client.js';
import { PythonMetadataCache } from '../../src/core/python/metadata.js';
import { createStoredZip } from './zip-fixture.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        })
    )
  );
});

async function startServer(
  handler: http.RequestListener
): Promise<{ baseUrl: string; server: http.Server }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${String(address.port)}`, server };
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function metadata(name = 'demo', version = '1.0'): Buffer {
  return Buffer.from(
    `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\nRequires-Dist: child>=1\n`
  );
}

describe('HttpPythonIndexClient', () => {
  it('parses PEP 691 JSON, resolves relative URLs, and caches verified core metadata', async () => {
    const metadataBody = metadata();
    let metadataRequests = 0;
    const { baseUrl } = await startServer((request, response) => {
      if (request.url === '/simple/demo/') {
        expect(request.headers.accept).toBe('application/vnd.pypi.simple.v1+json');
        response.setHeader('content-type', 'application/vnd.pypi.simple.v1+json; charset=utf-8');
        response.end(
          JSON.stringify({
            files: [
              {
                'core-metadata': { sha256: sha256(metadataBody) },
                filename: 'demo-1.0-py3-none-any.whl',
                hashes: { sha256: 'aa'.repeat(32) },
                'requires-python': '>=3.9',
                url: `../../files/demo-1.0-py3-none-any.whl#sha256=${'aa'.repeat(32)}`,
              },
            ],
            meta: { 'api-version': '1.4' },
            name: 'demo',
          })
        );
        return;
      }
      if (request.url === '/files/demo-1.0-py3-none-any.whl.metadata') {
        metadataRequests += 1;
        response.end(metadataBody);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const client = new HttpPythonIndexClient(`${baseUrl}/simple/`, { retryDelaysMs: [] });
    const project = await client.getProject('Demo');
    expect(project).toMatchObject({ apiVersion: '1.4', name: 'demo' });
    expect(project.files[0]).toMatchObject({
      requiresPython: '>=3.9',
      url: `${baseUrl}/files/demo-1.0-py3-none-any.whl#sha256=${'aa'.repeat(32)}`,
    });

    const cache = new PythonMetadataCache();
    await expect(client.getMetadata(project.files[0]!, cache)).resolves.toMatchObject({
      metadata: { name: 'demo', requiresDist: ['child>=1'], version: '1.0' },
      source: 'core-metadata',
    });
    await expect(client.getMetadata(project.files[0]!, cache)).resolves.toMatchObject({
      source: 'cache',
    });
    expect(metadataRequests).toBe(1);
  });

  it('falls back to bounded wheel metadata extraction', async () => {
    const wheel = createStoredZip([
      { data: metadata(), name: 'demo-1.0.dist-info/METADATA' },
      { data: Buffer.from('x'), name: 'demo/__init__.py' },
    ]);
    const { baseUrl } = await startServer((request, response) => {
      if (request.url === '/files/demo-1.0-py3-none-any.whl') {
        response.end(wheel);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const client = new HttpPythonIndexClient(`${baseUrl}/simple`, { retryDelaysMs: [] });
    const file: PythonIndexFile = {
      filename: 'demo-1.0-py3-none-any.whl',
      hashes: { sha256: sha256(wheel) },
      url: `${baseUrl}/files/demo-1.0-py3-none-any.whl`,
    };

    await expect(client.getMetadata(file, new PythonMetadataCache())).resolves.toMatchObject({
      metadata: { name: 'demo', version: '1.0' },
      source: 'wheel',
    });
  });

  it('rejects HTML indexes, unsupported API versions, and metadata hash mismatches', async () => {
    const { baseUrl } = await startServer((request, response) => {
      if (request.url === '/html/demo/') {
        response.setHeader('content-type', 'text/html');
        response.end('<html></html>');
        return;
      }
      if (request.url === '/v2/demo/') {
        response.setHeader('content-type', 'application/vnd.pypi.simple.v1+json');
        response.end(JSON.stringify({ files: [], meta: { 'api-version': '2.0' }, name: 'demo' }));
        return;
      }
      if (request.url === '/files/demo.whl.metadata') {
        response.end(metadata());
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    await expect(
      new HttpPythonIndexClient(`${baseUrl}/html`, { retryDelaysMs: [] }).getProject('demo')
    ).rejects.toThrow(/PEP 691 JSON/);
    await expect(
      new HttpPythonIndexClient(`${baseUrl}/v2`, { retryDelaysMs: [] }).getProject('demo')
    ).rejects.toThrow(/Unsupported.*2\.0/);

    const client = new HttpPythonIndexClient(`${baseUrl}/simple`, { retryDelaysMs: [] });
    await expect(
      client.getMetadata(
        {
          coreMetadata: { sha256: '00'.repeat(32) },
          filename: 'demo-1.0-py3-none-any.whl',
          hashes: { sha256: 'aa'.repeat(32) },
          url: `${baseUrl}/files/demo.whl`,
        },
        new PythonMetadataCache()
      )
    ).rejects.toThrow(/sha256 mismatch/);
  });
});
