import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as tar from 'tar';
import yauzl from 'yauzl';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repositoryRoot, 'support', 'python', 'uv-tool-manifest.json');

function fail(message) {
  throw new Error(`[python-planner-spike] ${message}`);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function currentAssetKey() {
  const key = `${process.platform}-${process.arch}`;
  if (
    ![
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ].includes(key)
  ) {
    fail(`unsupported collector platform ${key}`);
  }
  return key;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with ${String(result.status)}`);
  }
  return result.stdout?.trim() ?? '';
}

async function extractZip(file, destination) {
  await new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('zip open returned no archive'));
        return;
      }
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        const output = path.resolve(destination, entry.fileName);
        if (!output.startsWith(`${path.resolve(destination)}${path.sep}`)) {
          zip.close();
          reject(new Error(`unsafe zip entry ${entry.fileName}`));
          return;
        }
        if (entry.fileName.endsWith('/')) {
          fs.mkdir(output, { recursive: true }).then(() => zip.readEntry(), reject);
          return;
        }
        fs.mkdir(path.dirname(output), { recursive: true })
          .then(
            () =>
              new Promise((entryResolve, entryReject) => {
                zip.openReadStream(entry, (streamError, stream) => {
                  if (streamError || !stream) {
                    entryReject(streamError ?? new Error('zip entry returned no stream'));
                    return;
                  }
                  fs.open(output, 'w')
                    .then((handle) => {
                      const outputStream = handle.createWriteStream();
                      stream.on('error', entryReject);
                      outputStream.on('error', entryReject);
                      outputStream.on('close', entryResolve);
                      stream.pipe(outputStream);
                    })
                    .catch(entryReject);
                });
              })
          )
          .then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  });
}

async function findExecutable(root) {
  const expected = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.name === expected) {
        return candidate;
      }
    }
  }
  fail(`archive did not contain ${expected}`);
}

async function acquireUv(tempRoot, manifest) {
  if (process.env.UV_BIN) {
    return path.resolve(process.env.UV_BIN);
  }

  const key = currentAssetKey();
  const asset = manifest.assets[key];
  if (!asset) {
    fail(`manifest has no asset for ${key}`);
  }
  const response = await fetch(asset.url, { redirect: 'follow' });
  if (!response.ok) {
    fail(`uv download failed with HTTP ${String(response.status)}`);
  }
  const archiveContent = Buffer.from(await response.arrayBuffer());
  if (archiveContent.byteLength !== asset.size) {
    fail(
      `uv size mismatch: expected ${String(asset.size)}, got ${String(archiveContent.byteLength)}`
    );
  }
  const digest = sha256(archiveContent);
  if (digest !== asset.sha256) {
    fail(`uv SHA-256 mismatch: expected ${asset.sha256}, got ${digest}`);
  }

  const archive = path.join(tempRoot, asset.file);
  const extracted = path.join(tempRoot, 'uv');
  await fs.writeFile(archive, archiveContent);
  await fs.mkdir(extracted);
  if (asset.file.endsWith('.tar.gz')) {
    await tar.x({ cwd: extracted, file: archive, strict: true });
  } else if (asset.file.endsWith('.zip')) {
    await extractZip(archive, extracted);
  } else {
    fail(`unsupported uv archive ${asset.file}`);
  }
  return findExecutable(extracted);
}

function uvArgs(input, output, target) {
  return [
    'pip',
    'compile',
    input,
    '--python-version',
    '3.11',
    '--python-platform',
    target,
    '--only-binary=:all:',
    '--format',
    'pylock.toml',
    '--no-header',
    '--quiet',
    '--output-file',
    output,
  ];
}

async function compileTwice(uv, root, environment, input, name, target, expectedTag) {
  const outputRoot = path.join(root, name);
  await fs.mkdir(outputRoot);
  const first = path.join(outputRoot, 'pylock.first.toml');
  const second = path.join(outputRoot, 'pylock.second.toml');
  run(uv, uvArgs(input, first, target), { env: environment });
  run(uv, uvArgs(input, second, target), { env: environment });
  const [firstContent, secondContent] = await Promise.all([
    fs.readFile(first, 'utf8'),
    fs.readFile(second, 'utf8'),
  ]);
  if (firstContent !== secondContent) {
    fail(`${name} pylock output is not deterministic`);
  }
  if (!firstContent.includes(expectedTag)) {
    fail(`${name} pylock did not select a ${expectedTag} wheel`);
  }
  if (firstContent.includes('sdist =')) {
    fail(`${name} pylock unexpectedly contains an sdist`);
  }
  return {
    bytes: Buffer.byteLength(firstContent),
    sha256: sha256(firstContent),
    target,
  };
}

async function countRawRequirementHashes(uv, root, environment, input) {
  const output = path.join(root, 'raw-requirements.txt');
  run(
    uv,
    [
      'pip',
      'compile',
      input,
      '--python-version',
      '3.11',
      '--python-platform',
      'x86_64-manylinux2014',
      '--only-binary=:all:',
      '--format',
      'requirements.txt',
      '--generate-hashes',
      '--no-annotate',
      '--no-header',
      '--quiet',
      '--output-file',
      output,
    ],
    { env: environment }
  );
  const content = await fs.readFile(output, 'utf8');
  const hashes = content.match(/--hash=sha256:[a-f0-9]{64}/g) ?? [];
  if (hashes.length <= 1) {
    fail('expected raw generated requirements to contain hashes beyond the selected wheel');
  }
  return hashes.length;
}

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-python-spike-'));
try {
  const uv = await acquireUv(tempRoot, manifest);
  const version = run(uv, ['--version'], { capture: true });
  if (!version.startsWith(`uv ${manifest.version} `) && version !== `uv ${manifest.version}`) {
    fail(`expected uv ${manifest.version}, got ${version}`);
  }

  const input = path.join(tempRoot, 'requirements.in');
  await fs.writeFile(input, 'orjson==3.10.18\n');
  const environment = {
    ...process.env,
    UV_CACHE_DIR: path.join(tempRoot, 'cache'),
    UV_NO_PROGRESS: '1',
    UV_NO_SYSTEM_CONFIG: '1',
    UV_PYTHON_BIN_DIR: path.join(tempRoot, 'python-bin'),
    UV_PYTHON_INSTALL_DIR: path.join(tempRoot, 'python'),
  };

  const results = {
    linuxManylinux2014: await compileTwice(
      uv,
      tempRoot,
      environment,
      input,
      'linux-manylinux2014',
      'x86_64-manylinux2014',
      'manylinux_2_17_x86_64'
    ),
    linuxManylinux235: await compileTwice(
      uv,
      tempRoot,
      environment,
      input,
      'linux-manylinux235',
      'x86_64-manylinux_2_35',
      'manylinux_2_17_x86_64'
    ),
    windowsX64: await compileTwice(
      uv,
      tempRoot,
      environment,
      input,
      'windows-x64',
      'x86_64-pc-windows-msvc',
      'win_amd64'
    ),
  };
  const rawRequirementsHashCount = await countRawRequirementHashes(
    uv,
    tempRoot,
    environment,
    input
  );

  process.stdout.write(
    `${JSON.stringify(
      { fixture: 'orjson==3.10.18', rawRequirementsHashCount, results, uv: version },
      null,
      2
    )}\n`
  );
} finally {
  await fs.rm(tempRoot, { force: true, recursive: true });
}
