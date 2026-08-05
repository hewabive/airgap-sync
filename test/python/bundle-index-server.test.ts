import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import { startPythonBundleIndexServer } from '../../src/core/python/bundle-index-server.js';
import type { PythonSeedManifest } from '../../src/core/python/bundle.js';

let bundleDir: string;

function manifest(file = 'python/wheels/demo-1.0.0-py3-none-any.whl'): PythonSeedManifest {
  return {
    createdAt: '2026-08-05T00:00:00.000Z',
    packages: [
      {
        files: [
          {
            coreMetadata: {
              metadataVersion: '2.4',
              name: 'Demo_Package',
              projectUrls: [],
              providesExtra: [],
              requiresDist: [],
              requiresPython: '>=3.10,<3.14',
              version: '1.0.0',
            },
            environments: ['linux-glibc-x86_64--py310'],
            file,
            filename: 'demo-1.0.0-py3-none-any.whl',
            kind: 'wheel',
            sha256: 'a'.repeat(64),
            sourceHashes: { sha256: 'a'.repeat(64) },
            url: 'https://example.test/demo-1.0.0-py3-none-any.whl',
          },
        ],
        name: 'Demo_Package',
        resolvedFrom: [],
        version: '1.0.0',
      },
    ],
    roots: ['Demo_Package==1.0.0'],
    schemaVersion: 1,
    sourceIndex: 'https://pypi.org/simple/',
    targetEnvironments: [],
  };
}

describe('Python bundle-only package index', () => {
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-python-index-'));
  });

  afterEach(async () => {
    await fs.remove(bundleDir);
  });

  it('serves normalized PEP 503 project pages and only bundled wheel bytes', async () => {
    const wheelPath = path.join(bundleDir, 'python/wheels/demo-1.0.0-py3-none-any.whl');
    await fs.ensureDir(path.dirname(wheelPath));
    await fs.writeFile(wheelPath, 'wheel fixture');
    const server = await startPythonBundleIndexServer(bundleDir, manifest());

    try {
      const root = await fetch(server.indexUrl);
      expect(root.status).toBe(200);
      expect(await root.text()).toContain('demo-package/');

      const project = await fetch(`${server.indexUrl}Demo_Package/`);
      expect(project.status).toBe(200);
      const projectHtml = await project.text();
      expect(projectHtml).toContain('#sha256=' + 'a'.repeat(64));
      expect(projectHtml).toContain('data-requires-python="&gt;=3.10,&lt;3.14"');

      const wheelUrl = /href="([^"#]+)#sha256=/u.exec(projectHtml)?.[1];
      expect(wheelUrl).toBeDefined();
      const wheel = await fetch(new URL(wheelUrl!, server.indexUrl));
      expect(wheel.status).toBe(200);
      expect(await wheel.text()).toBe('wheel fixture');

      expect((await fetch(`${server.indexUrl}not-bundled/`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('rejects bundle file paths that escape the bundle', async () => {
    await expect(
      startPythonBundleIndexServer(bundleDir, manifest('../outside.whl'))
    ).rejects.toThrow('Unsafe Python bundle index file path');
  });
});
