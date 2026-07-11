import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from '../../src/core/fs.js';
import { readWheelMetadata } from '../../src/core/python/wheel-metadata.js';
import { createStoredZip } from './zip-fixture.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('readWheelMetadata', () => {
  it('reads the top-level dist-info METADATA entry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-wheel-test-'));
    tempDirs.push(dir);
    const wheelPath = path.join(dir, 'demo-1.0-py3-none-any.whl');
    await fs.writeFile(
      wheelPath,
      createStoredZip([
        { data: Buffer.from('print("demo")'), name: 'demo/__init__.py' },
        {
          data: Buffer.from('Metadata-Version: 2.1\nName: demo\nVersion: 1.0\n'),
          name: 'demo-1.0.dist-info/METADATA',
        },
      ])
    );

    await expect(readWheelMetadata(wheelPath)).resolves.toContain('Name: demo');
  });

  it('rejects wheels without metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-wheel-test-'));
    tempDirs.push(dir);
    const wheelPath = path.join(dir, 'empty.whl');
    await fs.writeFile(
      wheelPath,
      createStoredZip([{ data: Buffer.from('x'), name: 'demo/__init__.py' }])
    );
    await expect(readWheelMetadata(wheelPath)).rejects.toThrow(/does not contain/);
  });
});
