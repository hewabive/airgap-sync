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

The current live collector checks are explicit:

```bash
npm run e2e:python-planner
npm run e2e:ktransformers
```

The KTransformers check exercises a difficult native-wheel boundary: broad
Windows/Linux coverage fails, while the reviewed Linux branch can be collected. It is
a useful fixture, not the definition of Python support. Today this test checks planning
and transitional generated records; it does not yet prove that an ordinary client can
install KTransformers from the final Gitea index or transfer model weights.

The Python end-to-end acceptance suite should publish into a clean Gitea owner and, for
every supported compatibility cell, install representative applications with both
ordinary pip resolution and ordinary uv resolution. The test environment must expose
only the Gitea PyPI index. A lock-driven `--no-deps` install may remain as an additional
integrity test, but cannot replace repository-resolution tests.

To measure sequential read and SHA-256 performance on the actual removable medium:

```bash
npm run benchmark:python-bundle -- /media/USB/airgap-bundle --passes=2
```

Suggested test groups:

- spec parsing with `npm-package-arg`;
- range and tag resolution against fixture metadata;
- alias handling;
- manifest and nested package.json input;
- dependency graph traversal and cycle prevention;
- bundle manifest generation;
- npm publish command construction;
- Python coverage/recipe/planner decisions against captured fixtures;
- CPython 3.10–3.13 × Windows/Linux x86-64 compatibility-cell expansion;
- minimum wheel-cover selection, including universal and `abi3` sharing;
- fixed-point resolution against the exact candidate set published to Gitea;
- plain pip and uv installs against a clean, isolated Gitea PyPI owner;
- interrupted Python download/publication recovery and idempotent retries;
- destination-state conflicts and reference-safe application artifact pruning.

## Safety Rules

- Never publish to public npm registries from npm publishing code paths.
- Publish tarballs with a temporary tag, then restore source registry tags recorded in
  the bundle.
- Generated bundle files should be deterministic where practical.
