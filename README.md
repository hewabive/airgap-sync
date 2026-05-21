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
- collect Git dependencies as portable source mirrors;
- apply both sides in the closed network and verify installs do not reach outside.

## Status

This repository is an early implementation. The npm registry package path is usable:
package-spec input, recursive dependency fetch, manifest input, bundle validation,
metadata caching, bundle inspection, and Verdaccio publish are implemented. Git
dependency mirroring is implemented as portable source metadata, local mirror fetch,
Gitea repository creation, mirror push, and Git URL rewrite steps. Higher-level repository
orchestration has a first online `collect` command; automated install verification is
still design work.

## Target Workflow

```bash
# First setup on the portable drive.
airgap-sync init
airgap-sync target add git https://github.com/acme/app.git --branch main
airgap-sync target add npm eslint@latest

# Online machine: refresh configured targets and collect npm/Git closure.
airgap-sync collect

# Closed network: populate Verdaccio and Gitea from the transfer bundle.
airgap-sync apply ./bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local \
  --gitea-token "$GITEA_TOKEN" \
  --preserve-git-paths
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

Current lower-level commands are documented in the [CLI Contract](./docs/cli.md). The
workflow above is the direction for the next orchestration layer.

The configured workspace lives on removable media:

```text
airgap-sync.json          Target list and defaults
repos/                    Working clones for configured Git targets
bundle/                   Transfer bundle for Verdaccio and Gitea
bundle/workspace-snapshot.json  Portable target snapshot for verification
cache/                    Reserved for local caches
reports/                  Reserved for operator-facing reports
```

The lower-level commands remain available for debugging and one-off use:

```bash
# Online machine: refresh project repositories, then collect npm and Git closure.
airgap-sync repos update ./repos
airgap-sync collect ./repos -o ./airgap-bundle

# Closed network: publish npm packages and push Git mirrors.
airgap-sync apply ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local \
  --preserve-git-paths
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
