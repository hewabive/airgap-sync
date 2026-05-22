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

- fetch or update configured Git repositories into a portable bundle;
- discover Node dependency graphs across those repositories;
- collect npm registry packages for Verdaccio;
- collect target repositories and Git dependencies as portable source mirrors;
- apply both sides in the closed network and verify installs do not reach outside.

## Status

This repository is an early but usable implementation. The core workflow is in place:
workspace targets, recursive npm dependency collection, lockfile and nested
package.json scanning, Git target/dependency mirroring, Verdaccio publish, dist-tag
restoration, Gitea repository creation, mirror push, static bundle validation, and
install verification.

It still needs real-environment hardening around large repositories, authentication
variants, performance tuning, and operator ergonomics.

Current limitations:

- Source registry and Git host authentication is still explicit; there is no automatic
  credential discovery yet.
- Verification proves package-manager installs for configured Git targets, but it does
  not yet enforce a network-deny sandbox around the process. Use
  `verify install --ignore-scripts` when install scripts should not execute during
  verification.
- Git mirrors are pushed with broad mirror semantics; protected branch policies in a
  target Gitea instance may need manual handling.

## Target Workflow

Install it in the workspace on removable media:

```bash
mkdir -p /media/USB/airgap-sync
cd /media/USB/airgap-sync
pnpm add -D airgap-sync
pnpm exec airgap-sync init
```

After a global install or `pnpm dlx airgap-sync`, the same commands can be run as
`airgap-sync ...`.

For guided operation, start the interactive menu. With no command, `airgap-sync`
opens the menu by default; `airgap-sync -h` still prints the command reference.

```bash
pnpm exec airgap-sync
```

```bash
# First setup on the portable drive.
airgap-sync init
airgap-sync target add git https://github.com/acme/app.git --branch main
airgap-sync target add npm eslint@latest

# Online machine: update bundle-local mirrors and collect npm/Git closure.
airgap-sync collect
airgap-sync verify ./airgap-bundle

# Closed network: populate Verdaccio and Gitea from the transfer bundle.
airgap-sync apply ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local \
  --gitea-token "$GITEA_TOKEN"
airgap-sync verify ./airgap-bundle
airgap-sync verify install ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local \
  --ignore-scripts
```

The intended Git mirror layout preserves upstream owner/repository paths. For example,
`https://github.com/antvis/G2.git` should be mirrored as
`http://gitea.local/antvis/G2.git`. That lets consumer machines use one broad Git
rewrite rule instead of many repository-specific rules:

```bash
git config --global url."http://gitea.local/".insteadOf "https://github.com/"
```

After applying the bundle, normal installs should use the closed-network services:

```bash
npm ci --registry http://verdaccio.local:4873
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873
```

Current lower-level commands are documented in the [CLI Reference](./docs/cli.md).

The configured workspace lives on removable media:

```text
airgap-sync.json          Target list and defaults
airgap-bundle/            Transfer bundle for Verdaccio and Gitea
airgap-bundle/git-mirrors/ Git mirrors for target repositories and Git dependencies
airgap-bundle/workspace-snapshot.json  Portable target snapshot for verification
```

`airgap-sync.json` belongs next to `airgap-bundle/` on the removable media. It is the
workspace configuration for repeated syncs, not part of a single transfer bundle.

The lower-level commands remain available for debugging and one-off use:

```bash
# Online machine: refresh project repositories, then collect npm and Git closure.
airgap-sync repos update ./repos
airgap-sync collect ./repos -o ./airgap-bundle

# Closed network: publish npm packages and push Git mirrors.
airgap-sync apply ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local
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
- pnpm 11 or newer

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
pnpm e2e:local   # Run the local Gitea/Verdaccio integration test
```

## Documentation

- [Architecture](./docs/architecture.md)
- [CLI Reference](./docs/cli.md)
- [Bundle Format](./docs/bundle-format.md)
- [Development Guide](./docs/development.md)
- [Workflows](./docs/workflows.md)
- [Changelog](./CHANGELOG.md)
- [Security Policy](./SECURITY.md)

## License

MIT
