# Development Guide

## Setup

```bash
corepack enable
pnpm install
```

## Checks

```bash
pnpm check
pnpm format:check
```

## Local Verdaccio

The repository includes a Verdaccio config for integration testing:

```bash
pnpm registry:start
```

This config has no uplinks and no package `proxy` rules. The registry is populated only
through `npm publish`, which matches the offline target environment.

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
- dependency graph traversal and cycle prevention;
- bundle manifest generation;
- publish command construction.

## Safety Rules

- Never publish to public npm registries from `publish`.
- Avoid assigning `latest` during tarball publish; use a temporary tag and restore tags
  afterwards.
- Generated bundle files should be deterministic where practical.
