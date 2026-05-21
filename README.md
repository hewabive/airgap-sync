# airgap-sync

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

The broader target is an airgap sync workflow for portable media:

- refresh one or more Git repositories on an online machine;
- discover Node dependency graphs across those repositories;
- collect npm registry packages for Verdaccio;
- collect Git dependencies for a local Gitea mirror;
- apply both sides in the closed network and verify installs do not reach outside.

## Status

This repository is an early implementation. The npm registry package path is usable:
package-spec input, recursive dependency fetch, manifest input, bundle validation,
metadata caching, bundle inspection, and Verdaccio publish are implemented. Git
dependency mirroring is implemented as explicit planning, local mirror fetch, Gitea
repository creation, mirror push, and Git URL rewrite steps. Higher-level repository
orchestration and automated install verification are still design work.

## Current Workflow

```bash
# Online machine: build npm bundle and collect Git mirrors.
airgap-sync fetch --manifest ./package.json --include-dev -o ./seed
airgap-sync git plan ./seed --gitea http://gitea.local --owner npm-mirrors --write
airgap-sync git fetch ./seed

# Closed network: populate Verdaccio and Gitea.
airgap-sync publish ./seed -r http://verdaccio.local:4873
airgap-sync git create-repos ./seed --token "$GITEA_TOKEN"
airgap-sync git apply ./seed
airgap-sync git config ./seed --global
```

For a Gitea organization, add `--owner-type org` to `git create-repos`.

After that, normal installs should use the closed-network services:

```bash
npm ci --registry http://verdaccio.local:4873
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873
```

Future commands are expected to cover a larger workflow:

```bash
# Online machine: refresh Git repositories on removable media.
airgap-sync git fetch ./repos

# Online machine: collect npm and Git dependency closure.
airgap-sync collect ./repos -o ./airgap-bundle

# Closed network: push mirrored Git repositories and publish npm packages.
airgap-sync apply ./airgap-bundle \
  --gitea http://gitea.local \
  --registry http://verdaccio.local:4873
```

## Design Principles

- Publish into the target registry with standard npm operations.
- Resolve `version`, `range`, `tag`, and `alias` specs using npm registry metadata.
- Download only the dependency graph needed by the input manifests, not the entire npm registry.
- Restore required tags and the upstream `latest` tag for each published package name.
- Keep generated reports explicit enough to audit what was fetched and why.
- Support both package specs (`react@latest`) and project manifests (`package.json`).
- Treat Git dependencies as first-class external dependencies, not as registry packages.

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
- [Workflows](./docs/workflows.md)

## License

MIT
