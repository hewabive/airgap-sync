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
