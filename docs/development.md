# Development Guide

## Setup

```bash
npm ci
npm run build
npm run cli
```

`npm run cli` runs `dist/cli.cjs` from the source checkout. The `airgap-sync`
binary name is available automatically only after the package is installed as a
dependency or installed globally.

## Checks

```bash
npm run check
npm run format:check
```

## Local End-To-End Test

With a local Gitea instance running, the full workflow can be tested against temporary
repositories and a temporary Verdaccio instance:

```bash
GITEA_URL=http://127.0.0.1:3000 \
GITEA_USER=maxim \
GITEA_PASSWORD=11111111 \
npm run e2e:local
```

The script creates a Gitea token, creates public test repositories, adds a Git
dependency that looks like a GitHub dependency, builds an `airgap-bundle`, publishes npm
tarballs into a no-proxy Verdaccio through authenticated `npm publish`, mirrors the Git
dependency into Gitea, restores dist-tags, and runs `verify install`.

## Local Verdaccio

The repository includes a Verdaccio config for integration testing:

```bash
npm run registry:start
```

This config has no uplinks and no package `proxy` rules. The registry is populated only
through `npm publish`, which matches the offline target environment.
`max_body_size` is intentionally high because large native package tarballs can exceed
Verdaccio's smaller defaults and fail with `E413`.

Before publishing test bundles, create a local user:

```bash
npm adduser --registry http://localhost:4873
```

## Build Output

The library entrypoint is ESM:

```text
dist/index.js
dist/index.d.ts
```

The CLI is CommonJS for broad Node CLI compatibility:

```text
dist/cli.cjs
```

## Testing Strategy

Unit tests should cover resolver decisions without hitting the real npm registry.
Network tests should be explicit integration tests and should not run by default.

Suggested test groups:

- spec parsing with `npm-package-arg`;
- range and tag resolution against fixture metadata;
- alias handling;
- manifest and nested package.json input;
- dependency graph traversal and cycle prevention;
- bundle manifest generation;
- npm publish command construction.

## Safety Rules

- Never publish to public npm registries from npm publishing code paths.
- Publish tarballs with a temporary tag, then restore source registry tags recorded in
  the bundle.
- Generated bundle files should be deterministic where practical.
