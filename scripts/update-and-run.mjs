#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.cjs');

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    console.error(`[update] ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: 'inherit',
      ...options,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${String(code)}`));
    });
  });
}

await run('git', ['pull', '--ff-only']);
await run('npm', ['install']);
await run('npm', ['run', 'build']);
await run(process.execPath, [cli, ...process.argv.slice(2)], { cwd: process.cwd() });
