import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from '../src/core/fs.js';
import { downloadResumableHttpFile } from '../src/core/resumable-download.js';

let tempDir: string;

async function validateSha256(filePath: string, expected: string): Promise<void> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath) as AsyncIterable<Buffer>) {
    hash.update(chunk);
  }
  if (hash.digest('hex') !== expected) {
    throw new Error('SHA-256 mismatch');
  }
}

describe('resumable HTTP downloads', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-download-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('allows a slow transfer to run while bytes keep arriving', async () => {
    const content = Buffer.from('slow but continuously moving content');
    const digest = createHash('sha256').update(content).digest('hex');
    let offset = 0;
    const fetchImplementation: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            async pull(controller) {
              await delay(10);
              if (offset >= content.byteLength) {
                controller.close();
                return;
              }
              const end = Math.min(content.byteLength, offset + 5);
              controller.enqueue(content.subarray(offset, end));
              offset = end;
            },
          }),
          { headers: { 'Content-Length': String(content.byteLength) } }
        )
      );

    const result = await downloadResumableHttpFile({
      expectedSize: content.byteLength,
      fetch: fetchImplementation,
      retryDelaysMs: [],
      stallTimeoutMs: 25,
      targetPath: path.join(tempDir, 'slow.bin'),
      url: 'https://files.test/slow.bin',
      validateFile: async (filePath) => {
        await validateSha256(filePath, digest);
      },
    });

    expect(result).toMatchObject({ attempts: 1, size: content.byteLength });
  });

  it('retries a stalled body and resumes with a range request', async () => {
    const content = Buffer.from('resume this download after a stalled response');
    const digest = createHash('sha256').update(content).digest('hex');
    const splitAt = 17;
    const ranges: (string | null)[] = [];
    const fetchImplementation: typeof globalThis.fetch = (_input, init) => {
      ranges.push(new Headers(init?.headers).get('range'));
      if (ranges.length === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(content.subarray(0, splitAt));
              },
            }),
            { headers: { 'Content-Length': String(content.byteLength) } }
          )
        );
      }
      return Promise.resolve(
        new Response(content.subarray(splitAt), {
          headers: {
            'Content-Range': `bytes ${String(splitAt)}-${String(content.byteLength - 1)}/${String(content.byteLength)}`,
          },
          status: 206,
        })
      );
    };

    const result = await downloadResumableHttpFile({
      expectedSize: content.byteLength,
      fetch: fetchImplementation,
      retryDelaysMs: [1],
      stallTimeoutMs: 20,
      targetPath: path.join(tempDir, 'stalled.bin'),
      url: 'https://files.test/stalled.bin',
      validateFile: async (filePath) => {
        await validateSha256(filePath, digest);
      },
    });

    expect(result.attempts).toBe(2);
    expect(ranges).toEqual([null, `bytes=${String(splitAt)}-`]);
  });

  it('preserves a partial file across command invocations', async () => {
    const content = Buffer.from('persistent partial download content');
    const digest = createHash('sha256').update(content).digest('hex');
    const targetPath = path.join(tempDir, 'persistent.bin');
    const splitAt = 12;
    await expect(
      downloadResumableHttpFile({
        expectedSize: content.byteLength,
        fetch: () => Promise.resolve(new Response(content.subarray(0, splitAt))),
        retryDelaysMs: [],
        targetPath,
        url: 'https://files.test/persistent.bin',
      })
    ).rejects.toThrow('download ended early');
    await expect(fs.stat(`${targetPath}.download.partial`)).resolves.toMatchObject({
      size: splitAt,
    });

    const fetchImplementation: typeof globalThis.fetch = (_input, init) => {
      expect(new Headers(init?.headers).get('range')).toBe(`bytes=${String(splitAt)}-`);
      return Promise.resolve(
        new Response(content.subarray(splitAt), {
          headers: {
            'Content-Range': `bytes ${String(splitAt)}-${String(content.byteLength - 1)}/${String(content.byteLength)}`,
          },
          status: 206,
        })
      );
    };
    const result = await downloadResumableHttpFile({
      expectedSize: content.byteLength,
      fetch: fetchImplementation,
      retryDelaysMs: [],
      targetPath,
      url: 'https://files.test/persistent.bin',
      validateFile: async (filePath) => {
        await validateSha256(filePath, digest);
      },
    });

    expect(result.resumedFromBytes).toBe(splitAt);
    await expect(fs.readFile(targetPath)).resolves.toEqual(content);
  });
});
