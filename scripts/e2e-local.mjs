import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const giteaBaseUrl = process.env.GITEA_URL ?? 'http://127.0.0.1:3000';
const giteaUser = process.env.GITEA_USER ?? 'maxim';
const giteaPassword = process.env.GITEA_PASSWORD ?? '11111111';
const cliPath = path.resolve('dist/cli.cjs');
const fakeGithubOwner = 'airgap-sync-e2e';

function log(message) {
  console.log(`[e2e] ${message}`);
}

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${giteaUser}:${giteaPassword}`).toString('base64')}`;
}

function tokenAuthHeader(token) {
  return `token ${token}`;
}

function credentialUrl(repoName) {
  const url = new URL(giteaBaseUrl);
  url.username = giteaUser;
  url.password = giteaPassword;
  url.pathname = `/${giteaUser}/${repoName}.git`;
  return url.toString();
}

function publicRepoUrl(repoName) {
  return `${giteaBaseUrl.replace(/\/$/, '')}/${giteaUser}/${repoName}.git`;
}

function fakeGithubRepoUrl(repoName) {
  return `git+https://github.com/${fakeGithubOwner}/${repoName}.git#main`;
}

function authTokenConfigKey(registryUrl) {
  const url = new URL(registryUrl);
  const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `//${url.host}${pathname}:_authToken`;
}

async function writeGitConfig(filePath, rules) {
  await writeFile(
    filePath,
    rules
      .map((rule) =>
        [`[url "${rule.targetUrl}"]`, `\tinsteadOf = ${rule.insteadOf}`, ''].join('\n')
      )
      .join('\n')
  );
  return filePath;
}

async function writeOnlineGitConfig(workDir) {
  return writeGitConfig(path.join(workDir, 'online-gitconfig'), [
    {
      insteadOf: `https://github.com/${fakeGithubOwner}/`,
      targetUrl: `${giteaBaseUrl.replace(/\/$/, '')}/${giteaUser}/`,
    },
  ]);
}

async function writeApplyGitConfig(workDir) {
  const authenticated = new URL(giteaBaseUrl);
  authenticated.username = giteaUser;
  authenticated.password = giteaPassword;
  authenticated.pathname = '/';

  return writeGitConfig(path.join(workDir, 'apply-gitconfig'), [
    {
      insteadOf: `${giteaBaseUrl.replace(/\/$/, '')}/`,
      targetUrl: authenticated.toString(),
    },
  ]);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) : undefined;

  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${url} failed: ${response.status} ${bodyText}`);
  }

  return body;
}

async function createGiteaToken(name) {
  const body = await request(`${giteaBaseUrl}/api/v1/users/${giteaUser}/tokens`, {
    body: JSON.stringify({ name, scopes: ['all'] }),
    headers: { Authorization: basicAuthHeader() },
    method: 'POST',
  });
  const token = body?.sha1 ?? body?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`Gitea did not return a token: ${JSON.stringify(body)}`);
  }

  return { body, token };
}

async function deleteGiteaToken(tokenId) {
  if (tokenId === undefined || tokenId === null) {
    return;
  }

  await request(`${giteaBaseUrl}/api/v1/users/${giteaUser}/tokens/${tokenId}`, {
    headers: { Authorization: basicAuthHeader() },
    method: 'DELETE',
  }).catch((error) => {
    log(`token cleanup skipped: ${error.message}`);
  });
}

async function createRepo(token, name) {
  await request(`${giteaBaseUrl}/api/v1/user/repos`, {
    body: JSON.stringify({
      auto_init: false,
      default_branch: 'main',
      name,
      private: false,
    }),
    headers: { Authorization: tokenAuthHeader(token) },
    method: 'POST',
  });
}

async function deleteRepo(token, name) {
  await deleteOwnedRepo(token, giteaUser, name);
}

async function deleteOwnedRepo(token, owner, name) {
  await request(`${giteaBaseUrl}/api/v1/repos/${owner}/${name}`, {
    headers: { Authorization: tokenAuthHeader(token) },
    method: 'DELETE',
  }).catch((error) => {
    log(`repo cleanup skipped for ${owner}/${name}: ${error.message}`);
  });
}

async function deleteOrg(token, name) {
  await request(`${giteaBaseUrl}/api/v1/orgs/${name}`, {
    headers: { Authorization: tokenAuthHeader(token) },
    method: 'DELETE',
  }).catch((error) => {
    log(`org cleanup skipped for ${name}: ${error.message}`);
  });
}

async function run(command, args, options = {}) {
  log(options.label ?? `${command} ${args.join(' ')}`);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    const stdout = [];
    const stderr = [];

    if (child.stdout) {
      child.stdout.on('data', (chunk) => stdout.push(chunk));
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => stderr.push(chunk));
    }

    child.on('error', reject);
    child.on('close', (code) => {
      const output = {
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      };
      if (code === 0) {
        resolve(output);
        return;
      }

      const error = new Error(`${command} ${args.join(' ')} exited with ${code}`);
      error.output = output;
      reject(error);
    });
  });
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Could not allocate a TCP port'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) {
        return;
      }
    } catch {
      // Retry until Verdaccio is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startVerdaccio(workDir) {
  const port = await freePort();
  const registryUrl = `http://127.0.0.1:${port}`;
  const configPath = path.join(workDir, 'verdaccio.yaml');
  await writeFile(
    configPath,
    [
      `storage: ${path.join(workDir, 'verdaccio-storage')}`,
      `auth:`,
      `  htpasswd:`,
      `    file: ${path.join(workDir, 'htpasswd')}`,
      `packages:`,
      `  '@*/*':`,
      `    access: $all`,
      `    publish: $authenticated`,
      `  '**':`,
      `    access: $all`,
      `    publish: $authenticated`,
      `log: { type: stdout, format: pretty, level: warn }`,
      '',
    ].join('\n')
  );

  const child = spawn(
    path.resolve('node_modules/.bin/verdaccio'),
    ['--config', configPath, '--listen', `127.0.0.1:${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  await waitForHttp(`${registryUrl}/-/ping`);
  return {
    registryUrl,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    },
  };
}

async function createVerdaccioUser(registryUrl, options) {
  const response = await fetch(
    `${registryUrl}/-/user/org.couchdb.user:${encodeURIComponent(options.name)}`,
    {
      body: JSON.stringify({
        date: new Date().toISOString(),
        email: options.email,
        name: options.name,
        password: options.password,
        roles: [],
        type: 'user',
      }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      method: 'PUT',
    }
  );
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) : undefined;

  if (!response.ok) {
    throw new Error(`Verdaccio user creation failed: ${response.status} ${bodyText}`);
  }
  if (typeof body?.token !== 'string' || body.token.length === 0) {
    throw new Error(`Verdaccio did not return an npm token: ${JSON.stringify(body)}`);
  }

  return body.token;
}

async function writeNpmUserConfig(workDir, registryUrl) {
  const token = await createVerdaccioUser(registryUrl, {
    email: 'airgap-sync-e2e@example.invalid',
    name: 'airgap-sync-e2e',
    password: `airgap-sync-e2e-${Date.now()}`,
  });
  const filePath = path.join(workDir, 'npmrc');
  await writeFile(
    filePath,
    [
      `registry=${registryUrl}`,
      `${authTokenConfigKey(registryUrl)}=${token}`,
      'always-auth=true',
      '',
    ].join('\n')
  );
  return filePath;
}

async function createApplicationRepo(options) {
  const appDir = path.join(options.workDir, 'app-source');
  await mkdir(appDir, { recursive: true });
  await writeFile(
    path.join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'airgap-sync-e2e-app',
        private: true,
        scripts: {
          check: 'node index.js',
        },
        dependencies: {
          'airgap-sync-e2e-git-lib': fakeGithubRepoUrl(options.libRepoName),
          'is-odd': 'latest',
        },
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(appDir, 'index.js'),
    "const isOdd = require('is-odd');\nconst gitLib = require('airgap-sync-e2e-git-lib');\nif (!isOdd(3)) throw new Error('npm dependency failed');\nif (gitLib.answer() !== 42) throw new Error('git dependency failed');\n"
  );
  await run('npm', ['install', '--package-lock-only', '--registry', 'https://registry.npmjs.org'], {
    cwd: appDir,
    env: {
      GIT_CONFIG_GLOBAL: options.onlineGitConfig,
    },
  });
  await run('git', ['init'], { cwd: appDir });
  await run('git', ['checkout', '-B', 'main'], { cwd: appDir });
  await run('git', ['add', '.'], { cwd: appDir });
  await run(
    'git',
    [
      '-c',
      'user.name=airgap-sync-e2e',
      '-c',
      'user.email=airgap-sync-e2e@example.invalid',
      'commit',
      '-m',
      'Initial e2e app',
    ],
    { cwd: appDir }
  );
  await run('git', ['remote', 'add', 'origin', credentialUrl(options.repoName)], {
    cwd: appDir,
    label: 'git remote add origin <gitea-app-repo>',
  });
  await run('git', ['push', '-u', 'origin', 'main'], { cwd: appDir });
}

async function createGitPackageRepo(options) {
  const repoDir = path.join(options.workDir, 'git-lib-source');
  await mkdir(repoDir, { recursive: true });
  await writeFile(
    path.join(repoDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'airgap-sync-e2e-git-lib',
        version: '1.0.0',
        main: 'index.js',
      },
      null,
      2
    )}\n`
  );
  await writeFile(path.join(repoDir, 'index.js'), 'exports.answer = () => 42;\n');
  await run('git', ['init'], { cwd: repoDir });
  await run('git', ['checkout', '-B', 'main'], { cwd: repoDir });
  await run('git', ['add', '.'], { cwd: repoDir });
  await run(
    'git',
    [
      '-c',
      'user.name=airgap-sync-e2e',
      '-c',
      'user.email=airgap-sync-e2e@example.invalid',
      'commit',
      '-m',
      'Initial e2e git package',
    ],
    { cwd: repoDir }
  );
  await run('git', ['remote', 'add', 'origin', credentialUrl(options.repoName)], {
    cwd: repoDir,
    label: 'git remote add origin <gitea-git-package-repo>',
  });
  await run('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });
}

async function main() {
  await request(`${giteaBaseUrl}/api/v1/user`, {
    headers: { Authorization: basicAuthHeader() },
  });

  const id = `${Date.now()}-${process.pid}`;
  const tokenName = `airgap-sync-e2e-${id}`;
  const repoName = `airgap-sync-e2e-app-${id}`;
  const libRepoName = `airgap-sync-e2e-git-lib-${id}`;
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'airgap-sync-e2e-'));
  const mirrorOwner = fakeGithubOwner;
  let tokenInfo;
  let token;
  let applyGitConfig;
  let npmUserConfig;
  let onlineGitConfig;
  let verdaccio;

  try {
    log(`workdir ${workDir}`);
    await run('npm', ['run', 'build']);

    tokenInfo = await createGiteaToken(tokenName);
    token = tokenInfo.token;
    await createRepo(token, repoName);
    await createRepo(token, libRepoName);
    onlineGitConfig = await writeOnlineGitConfig(workDir);
    applyGitConfig = await writeApplyGitConfig(workDir);
    await createGitPackageRepo({ repoName: libRepoName, workDir });
    await createApplicationRepo({ libRepoName, onlineGitConfig, repoName, workDir });
    verdaccio = await startVerdaccio(workDir);
    npmUserConfig = await writeNpmUserConfig(workDir, verdaccio.registryUrl);

    const workspaceDir = path.join(workDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    await run('node', [cliPath, 'init'], { cwd: workspaceDir });
    await run('node', [cliPath, 'target', 'add', 'git', publicRepoUrl(repoName)], {
      cwd: workspaceDir,
    });
    await run('node', [cliPath, 'collect', '--concurrency', '4'], {
      cwd: workspaceDir,
      env: {
        GIT_CONFIG_GLOBAL: onlineGitConfig,
      },
    });
    await run('node', [cliPath, 'verify', './airgap-bundle'], { cwd: workspaceDir });
    await run(
      'node',
      [
        cliPath,
        'apply',
        './airgap-bundle',
        '--registry',
        verdaccio.registryUrl,
        '--gitea',
        giteaBaseUrl,
        '--gitea-token',
        token,
        '--public',
      ],
      {
        cwd: workspaceDir,
        env: {
          GIT_CONFIG_GLOBAL: applyGitConfig,
          NPM_CONFIG_USERCONFIG: npmUserConfig,
          npm_config_userconfig: npmUserConfig,
        },
        label:
          'node dist/cli.cjs apply ./airgap-bundle --registry <verdaccio> --gitea <gitea> --gitea-token <redacted> --public',
      }
    );
    await run('node', [cliPath, 'verify', './airgap-bundle'], { cwd: workspaceDir });
    await run(
      'node',
      [
        cliPath,
        'verify',
        'install',
        './airgap-bundle',
        '--registry',
        verdaccio.registryUrl,
        '--gitea',
        giteaBaseUrl,
      ],
      { cwd: workspaceDir }
    );

    const applyReport = JSON.parse(
      await readFile(path.join(workspaceDir, 'airgap-bundle', 'apply-report.json'), 'utf8')
    );
    log(`passed: ${applyReport.publish.published} packages published to ${verdaccio.registryUrl}`);
  } finally {
    if (verdaccio) {
      await verdaccio.stop();
    }
    if (token) {
      await deleteRepo(token, repoName);
      await deleteRepo(token, libRepoName);
      await deleteOwnedRepo(token, mirrorOwner, libRepoName);
      await deleteOrg(token, mirrorOwner);
    }
    await deleteGiteaToken(tokenInfo?.body?.id);
    if (process.env.AIRGAP_SYNC_E2E_KEEP_TEMP !== '1') {
      await rm(workDir, { force: true, recursive: true });
    } else {
      log(`kept temp dir ${workDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
