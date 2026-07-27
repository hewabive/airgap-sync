import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { semanticDigest } from '../../src/core/canonical-json.js';
import * as fs from '../../src/core/fs.js';
import type { PythonApplicationBundleIndex } from '../../src/core/python/application-bundle.js';
import type { PythonConsumerContract } from '../../src/core/python/consumer-contract.js';
import { publishPythonGenericArtifacts } from '../../src/core/python/generic-publisher.js';

let bundleDir: string;
let server: http.Server | undefined;

async function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

async function writeBundle(giteaBaseUrl = 'http://gitea.local'): Promise<void> {
  const directory = path.join(bundleDir, 'python/applications/demo--desktop-x64');
  const contract: PythonConsumerContract = {
    application: { name: 'demo', version: '1.0.0' },
    configuration: {
      environmentTemplatePath: 'consumer.env.template',
      indexUrl: `${giteaBaseUrl}/api/packages/pypi/pypi/simple`,
      pipConfigTemplatePath: 'pip.conf.template',
    },
    generatedFromPlanId: 'a'.repeat(64),
    installationOwner: 'consumer-infrastructure',
    platforms: [],
    publication: {
      owner: 'python-apps',
      package: 'demo-desktop-x64',
      version: '1.0.0+plan.aaaaaaaaaaaa',
    },
    schemaVersion: 1,
  };
  const contractContent = `${JSON.stringify(contract, null, 2)}\n`;
  const files = {
    'consumer-contract.json': contractContent,
    'environment-plan.json': `${JSON.stringify({
      publication: {
        applicationArtifactOwner: 'python-apps',
        pythonPackageOwner: 'pypi',
      },
    })}\n`,
    'plan-diff.json': '{"changed":true}\n',
    'prerequisites.json': '{"platforms":[]}\n',
  };
  for (const [filename, content] of Object.entries(files)) {
    await fs.writeFileAtomic(path.join(directory, filename), content);
  }
  const toolContent = Buffer.from('uv fixture');
  const toolSha = createHash('sha256').update(toolContent).digest('hex');
  const toolFile = `python/artifacts/optional/tools/uv/${toolSha}/uv.tar.gz`;
  await fs.writeFileAtomic(path.join(bundleDir, toolFile), toolContent);
  const index: PythonApplicationBundleIndex = {
    applications: [
      {
        application: { name: 'demo', version: '1.0.0' },
        artifactIds: [`${toolSha}:uv.tar.gz`],
        branchSizes: [],
        consumerConfigurationPaths: [],
        consumerContractPath: 'python/applications/demo--desktop-x64/consumer-contract.json',
        consumerDocumentDigests: {
          'python/applications/demo--desktop-x64/consumer-contract.json':
            semanticDigest(contractContent),
        },
        features: {},
        locks: [],
        planDiffPath: 'python/applications/demo--desktop-x64/plan-diff.json',
        planId: 'a'.repeat(64),
        planPath: 'python/applications/demo--desktop-x64/environment-plan.json',
        prerequisiteReportPath: 'python/applications/demo--desktop-x64/prerequisites.json',
        targetId: 'demo--desktop-x64',
      },
    ],
    artifacts: [
      {
        file: toolFile,
        filename: 'uv.tar.gz',
        id: `${toolSha}:uv.tar.gz`,
        kind: 'uv',
        publication: {
          owner: 'python-apps',
          package: 'uv-linux-glibc-x86_64',
          version: '0.11.16',
        },
        references: [
          {
            platforms: ['linux-glibc-x86_64'],
            targetId: 'demo--desktop-x64',
          },
        ],
        sha256: toolSha,
        size: toolContent.byteLength,
        sourceUrl: 'https://example.test/uv.tar.gz',
        version: '0.11.16',
      },
    ],
    createdAt: '2026-07-27T00:00:00.000Z',
    schemaVersion: 1,
    summary: {
      applications: 1,
      artifacts: 1,
      totalBytes: toolContent.byteLength,
    },
  };
  await fs.writeJsonAtomic(path.join(bundleDir, 'python/application-index.json'), index, {
    spaces: 2,
  });
}

beforeEach(async () => {
  bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-generic-publish-'));
});

afterEach(async () => {
  await fs.remove(bundleDir);
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    server = undefined;
  }
});

describe('publishPythonGenericArtifacts', () => {
  it('publishes contracts idempotently with Basic authentication', async () => {
    const published = new Map<string, Buffer>();
    const baseUrl = await listen((request, response) => {
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from('publisher:token').toString('base64')}`
      );
      if (request.method === 'GET') {
        const content = published.get(request.url ?? '');
        response.writeHead(content ? 200 : 404).end(content);
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = request.url ?? '';
        if (published.has(url)) {
          response.writeHead(409).end('already exists');
        } else {
          published.set(url, Buffer.concat(chunks));
          response.writeHead(201).end();
        }
      });
    });
    await writeBundle(baseUrl);
    const options = {
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      giteaBaseUrl: baseUrl,
    };

    const first = await publishPythonGenericArtifacts(options);
    const second = await publishPythonGenericArtifacts(options);

    expect(first).toMatchObject({ errors: [], published: 5, skipped: 0 });
    expect(second).toMatchObject({ errors: [], published: 0, skipped: 5 });
    expect([...published.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '/api/packages/python-apps/generic/demo-desktop-x64/1.0.0%2Bplan.aaaaaaaaaaaa/environment-plan.json'
        ),
        expect.stringContaining(
          '/api/packages/python-apps/generic/uv-linux-glibc-x86_64/0.11.16/uv.tar.gz'
        ),
      ])
    );
  });

  it('resumes an interrupted publication and verifies already accepted artifacts', async () => {
    const published = new Map<string, Buffer>();
    let interruptPlanDiff = true;
    const baseUrl = await listen((request, response) => {
      const url = request.url ?? '';
      if (request.method === 'GET') {
        const content = published.get(url);
        response.writeHead(content ? 200 : 404).end(content);
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (interruptPlanDiff && url.endsWith('/plan-diff.json')) {
          interruptPlanDiff = false;
          response.writeHead(503).end('injected interruption');
          return;
        }
        if (published.has(url)) {
          response.writeHead(409).end('already exists');
          return;
        }
        published.set(url, Buffer.concat(chunks));
        response.writeHead(201).end();
      });
    });
    await writeBundle(baseUrl);
    const options = {
      auth: { password: 'token', username: 'publisher' },
      bundleDir,
      concurrency: 1,
      giteaBaseUrl: baseUrl,
    };

    const interrupted = await publishPythonGenericArtifacts(options);
    const recovered = await publishPythonGenericArtifacts(options);

    expect(interrupted.published).toBe(4);
    expect(interrupted.errors).toHaveLength(1);
    expect(interrupted.errors[0]?.file).toContain('plan-diff.json');
    expect(recovered).toMatchObject({
      errors: [],
      published: 1,
      skipped: 4,
    });
    expect(published.size).toBe(5);
  });

  it('produces a dry-run plan without credentials', async () => {
    await writeBundle();
    const report = await publishPythonGenericArtifacts({
      bundleDir,
      dryRun: true,
      giteaBaseUrl: 'http://gitea.local',
    });

    expect(report).toMatchObject({ errors: [], planned: 5, published: 0, skipped: 0 });
  });
});
