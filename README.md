# npm-registry-seed

Build a publishable npm registry seed from package manifests, then publish it into
Verdaccio or another npm-compatible registry.

The goal is to make a normal package-manager install work against an offline registry:

```bash
npm ci --registry http://verdaccio.local:4873
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873
```

This project is intentionally not a lockfile copier. It resolves dependencies through
npm registry metadata, downloads the required tarballs, records the `dist-tags` needed
for safe registry behavior, and later restores those tags after publishing.

## Status

This repository is an early implementation. The package-spec, recursive dependency
fetch, manifest input, and Verdaccio publish paths are implemented, but the CLI is not
stable yet.

## Intended CLI

```bash
# Online machine: resolve package specs and build a transfer bundle.
npm-registry-seed fetch react@latest @types/node@^22 -o ./seed

# Or seed from a project manifest.
npm-registry-seed fetch --manifest ./package.json -o ./seed

# Monorepos are scanned recursively from the manifest directory.
npm-registry-seed fetch --manifest ./package.json --include-dev -o ./seed

# Offline machine: publish tarballs and restore required dist-tags.
npm-registry-seed publish ./seed -r http://192.168.0.10:4873
```

## Design Principles

- Publish into the target registry with standard npm operations.
- Resolve `version`, `range`, `tag`, and `alias` specs using npm registry metadata.
- Download only the dependency graph needed by the input manifests, not the entire npm registry.
- Restore required tags and the upstream `latest` tag for each published package name.
- Keep generated reports explicit enough to audit what was fetched and why.
- Support both package specs (`react@latest`) and project manifests (`package.json`).

## Development

Requirements:

- Node.js 22 or newer
- pnpm 10 or newer

Setup:

```bash
corepack enable
pnpm install
pnpm check
```

Useful commands:

```bash
pnpm build       # Type-check and build dist/
pnpm test        # Run tests
pnpm lint        # Run ESLint
pnpm format      # Format source and docs
pnpm check       # Lint, type-check, and test
```

## Documentation

- [Architecture](./docs/architecture.md)
- [CLI Contract](./docs/cli.md)
- [Bundle Format](./docs/bundle-format.md)
- [Development Guide](./docs/development.md)
- [Roadmap](./docs/roadmap.md)

## License

MIT
