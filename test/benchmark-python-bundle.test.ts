import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';

const execFileAsync = promisify(execFile);
let tempDir: string;

describe('Python bundle removable-media benchmark', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-benchmark-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('sequentially reads and verifies every indexed artifact', async () => {
    const content = Buffer.from('benchmark fixture');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const file = `python/artifacts/wheels/${sha256}/fixture.whl`;
    await fs.ensureDir(path.dirname(path.join(tempDir, file)));
    await fs.writeFile(path.join(tempDir, file), content);
    await fs.writeJson(path.join(tempDir, 'python/application-index.json'), {
      applications: [],
      artifacts: [
        {
          file,
          sha256,
        },
      ],
      schemaVersion: 1,
    });

    const result = await execFileAsync(
      process.execPath,
      ['scripts/benchmark-python-bundle.mjs', tempDir, '--passes=1'],
      {
        cwd: path.resolve('.'),
      }
    );
    const report = JSON.parse(result.stdout) as {
      artifacts: number;
      passes: { bytes: number; pass: number }[];
    };

    expect(report).toMatchObject({
      artifacts: 1,
      passes: [
        {
          bytes: content.byteLength,
          pass: 1,
        },
      ],
    });
  });
});
