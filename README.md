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

- download or update configured Git repositories into a portable bundle;
- discover Node dependency graphs across those repositories;
- download npm registry packages for Verdaccio;
- download target repositories and Git dependencies as portable source mirrors;
- publish both sides in the closed network and verify installs do not reach outside.

## Status

This repository is an early but usable implementation. The core workflow is in place:
workspace targets, recursive npm dependency collection, lockfile and nested
package.json scanning, Git target/dependency mirroring, Verdaccio publish, dist-tag
restoration, Gitea repository creation, mirror push, static bundle validation, and
install verification.

It still needs real-environment hardening around large repositories, authentication
variants, performance tuning, and operator ergonomics.

Current limitations:

- Source registry and upstream Git host authentication is still explicit; there is no
  automatic credential discovery yet. Closed-network Gitea authentication uses the
  provided token for both repository creation and mirror push.
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
npm init -y
npm install airgap-sync --omit=dev
npm exec -- airgap-sync init
```

After a global install, the same commands can be run as `airgap-sync ...`.
The examples below omit the `npm exec --` prefix for readability.

For guided operation, start the interactive menu. With no command, `airgap-sync`
opens the menu by default; `airgap-sync -h` still prints the command reference.

```bash
npm exec -- airgap-sync
```

```bash
# First setup on the portable drive.
airgap-sync init
airgap-sync target add git https://github.com/acme/app.git --branch main
airgap-sync target add npm eslint@latest

# Online machine: update bundle-local mirrors and download npm/Git closure.
airgap-sync download
airgap-sync verify ./airgap-bundle

# Closed network: populate Verdaccio and Gitea from the transfer bundle.
airgap-sync publish ./airgap-bundle \
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

After publishing the bundle, normal installs should use the closed-network services:

```bash
npm ci --registry http://verdaccio.local:4873
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873
```

Current lower-level commands are documented in the [CLI Reference](./docs/cli.md).

The configured workspace lives on removable media:

```text
airgap-sync.json          Target list and defaults
airgap-sync.secrets.json  Optional local secrets, ignored by Git
airgap-bundle/            Transfer bundle for Verdaccio and Gitea
airgap-bundle/git-mirrors/ Git mirrors for target repositories and Git dependencies
airgap-bundle/workspace-snapshot.json  Portable target snapshot for verification
```

`airgap-sync.json` belongs next to `airgap-bundle/` on the removable media. It is the
workspace configuration for repeated syncs, not part of a single transfer bundle. It
stores endpoints, target lists, bundle output, and menu defaults such as whether to
include dev dependencies, whether to traverse peer dependencies, whether to prune stale
bundle objects after a successful download, and how to handle the `latest` dist-tag and
reusable tag dependencies. Menu defaults are grouped by workflow step:
`defaults.download`, `defaults.publish`, and `defaults.verifyInstall`. The interactive
menu asks for these defaults while initializing a new workspace.
If you choose to save a Gitea token, it is written to `airgap-sync.secrets.json`.

The lower-level commands remain available for debugging and one-off use:

```bash
# Online machine: refresh project repositories, then download npm and Git closure.
airgap-sync repos update ./repos
airgap-sync download ./repos -o ./airgap-bundle
airgap-sync bundle prune ./airgap-bundle --dry-run

# Closed network: publish npm packages and push Git mirrors.
airgap-sync publish ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local
```

## Design Principles

- Publish into the target registry with standard npm operations.
- Resolve `version`, `range`, `tag`, and `alias` specs using npm registry metadata.
- Download only the dependency graph needed by the input manifests, not the entire npm registry.
- Restore required tags and assign `latest` according to the configured latest policy.
- Reuse stable tag resolutions across repeated downloads when the declaring parent did
  not change.
- Keep generated reports explicit enough to audit what was fetched and why.
- Support both package specs (`react@latest`) and project manifests (`package.json`).
- Treat Git dependencies as first-class external dependencies, not as registry packages.

## Development

Requirements:

- Node.js 22 or newer
- npm 11 or newer

Setup:

```bash
npm ci
npm run build
npm run cli
npm run check
```

Useful commands:

```bash
npm run build       # Type-check and build dist/
npm run cli         # Run the built CLI from this source checkout
npm test            # Run tests
npm run lint        # Run ESLint
npm run format      # Format source and docs
npm run check       # Lint, type-check, and test
npm run e2e:local   # Run the local Gitea/Verdaccio integration test
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
