import nativeFs from 'node:fs';
import path from 'node:path';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

export type { Dirent } from 'node:fs';

export const createWriteStream = nativeFs.createWriteStream;
export { copyFile, mkdtemp, readdir, readFile, stat, writeFile };

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

export async function writeJson(
  filePath: string,
  value: unknown,
  options: { spaces?: number } = {}
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const indentation = options.spaces ?? 0;
  const suffix = indentation > 0 ? '\n' : '';
  await writeFile(filePath, `${JSON.stringify(value, null, indentation)}${suffix}`);
}

export async function remove(filePath: string): Promise<void> {
  await rm(filePath, { force: true, recursive: true });
}
