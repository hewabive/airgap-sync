# airgap-sync

[![CI](https://github.com/hewabive/airgap-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/hewabive/airgap-sync/actions/workflows/ci.yml)

Synchronize Git repositories, npm packages, and Python wheels across an air gap using
removable media.

The intended workflow is simple for the operator:

1. On an online machine, run **Download updates** to refresh configured Git repositories,
   discover their Node dependency graph, and download the required npm packages and Git
   dependency mirrors into `airgap-bundle/`.
2. Move the removable media into the closed network.
3. Run **Publish updates** to populate the closed-network npm registry and Git host
   using normal `npm publish`, `npm dist-tag`, and `git push` operations.
4. Consumer machines install normally from the closed-network services:

```bash
npm ci --registry http://verdaccio.local:4873
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873
PIP_INDEX_URL=http://gitea.local/api/packages/pypi/pypi/simple pip install -r requirements.txt
```

`airgap-sync` is not a live proxy and not a full npm registry mirror. It builds the
publishable closure needed by configured projects and package targets, including
dist-tags that package manifests may reference.

## Status

This is an early but usable implementation. The main workflow is implemented and has
been tested with Verdaccio and Gitea:

- workspace targets stored on removable media;
- interactive menu as the default entry point;
- Git target mirroring with preserved owner/repository paths;
- recursive package discovery from nested `package.json` files and supported lockfiles;
- npm dependency resolution, tarball download, checksum validation, retries, and pruning;
- Python discovery from `requirements*.txt`, `uv.lock`, and `pylock*.toml`, with
  per-environment wheel resolution, hash validation, and Gitea PyPI publishing;
- Git dependency discovery and mirroring;
- npm publish with temporary tags, dist-tag restoration, and bundled `latest` handling;
- Gitea repository creation or publishing to already-created Git repositories;
- static bundle validation and install verification for configured Git targets;
- append-only download and publish run reports under `airgap-bundle/runs/`.

Expect more hardening around large real-world repositories, authentication variants,
performance on slow removable media, and operator ergonomics.

## Requirements

- Node.js 22 or newer
- npm 11 or newer
- Git
- Online side: access to the source npm registry and upstream Git hosts
- Closed side: an npm-compatible registry and Gitea 1.26.2 or newer with its package
  registry enabled

Verdaccio and Gitea are the tested closed-network path. Other npm-compatible registries
should work when they support `npm publish` and `npm dist-tag`. Generic Git hosts can
be used when target repositories already exist and normal Git push authentication is
enough.

## Quick Start

Create a workspace on removable media and install `airgap-sync` locally:

```bash
mkdir -p /media/USB/airgap-sync
cd /media/USB/airgap-sync
npm init -y
npm install airgap-sync --omit=dev
npm exec -- airgap-sync
```

Running `airgap-sync` without a subcommand opens the interactive menu. Use
`airgap-sync -h` for command help.

The menu covers the normal workflow:

- **Targets**: add, remove, or download one Git/npm target.
- **Download updates**: run the online collection phase.
- **Publish updates**: publish the bundle into the closed-network registry and Git host.
- **Verify installs**: run package-manager installs for configured Git targets.
- **Diagnostics**: inspect, validate, and summarize the bundle.
- **Settings**: configure endpoints, defaults, and saved credentials.

The same workflow can be scripted:

```bash
# First setup on the portable drive.
npm exec -- airgap-sync init
npm exec -- airgap-sync target add git https://github.com/acme/app.git --branch main
npm exec -- airgap-sync target add npm eslint@latest
npm exec -- airgap-sync target add pypi 'requests==2.32.4'
npm exec -- airgap-sync target add python-wheel 'https://example/vllm.whl' --sha256 <digest>

# Online machine.
npm exec -- airgap-sync download --prune
npm exec -- airgap-sync download --target 2
npm exec -- airgap-sync verify ./airgap-bundle

# Closed-network machine.
# Uses targetRegistry/giteaUrl from airgap-sync.json and GITEA_TOKEN or a saved token.
npm exec -- airgap-sync publish

npm exec -- airgap-sync verify install ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local \
  --ignore-scripts
```

After a global install, omit the `npm exec --` prefix.

For Windows operators who prefer a double-click workflow, optional launchers live in
[`support/windows`](./support/windows). Copy them to the online and closed-network
machines; they find the removable drive workspace automatically. The download launcher
updates and rebuilds the source checkout before running `download`; the publish
launcher only runs the already-built `publish` command.

## Git Mirrors

Git mirror paths preserve the upstream host and owner/repository path. For example,
`https://github.com/antvis/G2.git` is stored in the bundle as a mirror of
`github.com/antvis/G2` and can be published as:

```text
http://gitea.local/antvis/G2.git
```

That lets consumer machines use one broad rewrite rule instead of many
repository-specific rules:

```bash
git config --global url."http://gitea.local/".insteadOf "https://github.com/"
```

When repositories are created outside `airgap-sync`, skip Gitea API provisioning and
push to existing repositories:

```bash
npm exec -- airgap-sync publish ./airgap-bundle \
  --registry http://registry.local:4873 \
  --gitea http://git.local \
  --skip-git-provision \
  --git-username git \
  --git-password "$GIT_TOKEN"
```

## npm Tags

The bundle records real dist-tag requirements such as `node-fetch@cjs` when they appear
in package manifests. During publish, those tags are restored in the closed-network
registry after tarballs are published.

`latest` is handled separately:

- `latestPolicy: "bundled"` is the default. Publish assigns `latest` to the newest
  bundled version for each package name and does not downgrade an existing registry
  `latest` that already points to a newer semver version.
- `latestPolicy: "source"` also downloads the source registry's current `latest`
  version for each included package name. This is useful when storage is less important
  than keeping the offline registry close to the public registry.

Repeated downloads default to stable reuse for transitive tags and semver ranges. This
keeps old parent packages from pulling newer deep dependencies just because a public
registry tag or range moved. Use the `refresh` policies when the bundle is not the only
source of updates for the target registry.

## Workspace Files

The configured workspace lives next to the transfer bundle on removable media:

```text
airgap-sync.json          Target list, endpoints, bundle path, and menu defaults
airgap-sync.secrets.json  Optional saved secrets, ignored by Git
airgap-bundle/            Transfer bundle for npm packages and Git mirrors
```

`airgap-sync.json` is long-lived workspace state. It stores configured targets and
defaults for download, publish, and install verification. It is meant to move with the
bundle between machines.

`airgap-sync.secrets.json` is optional. If you save a Gitea token from the menu, it is
stored there in plaintext on the removable media.

The bundle contains the current transferable state plus audit reports:

```text
airgap-bundle/packages/                 npm tarballs
airgap-bundle/python-packages/          Python wheels
airgap-bundle/git-mirrors/              bare Git mirrors
airgap-bundle/seed-manifest.json        bundled npm package versions
airgap-bundle/python-seed-manifest.json bundled Python files and target environments
airgap-bundle/dist-tags.json            real dist-tag requirements
airgap-bundle/git-sources.json          Git source metadata
airgap-bundle/workspace-snapshot.json   targets for later verification
airgap-bundle/runs/                     append-only download/publish diagnostics
```

See [Bundle Format](./docs/bundle-format.md) for the full layout.

## Verification

`airgap-sync verify ./airgap-bundle` checks bundle consistency: manifests, referenced
tarballs and wheels, package identity and hashes, reports, and Git metadata.

`airgap-sync verify install ./airgap-bundle` runs real package-manager installs for
configured Git targets against the closed-network npm registry and Git host. It is the
closest automated check to the final consumer workflow, but it does not yet enforce a
network-deny sandbox. Use `--ignore-scripts` when install scripts should not run during
verification. When the machine has a Python interpreter exactly matching a configured
target environment, the command also creates a temporary venv and installs the pinned
bundled wheels from Gitea; otherwise the Python check is recorded as skipped.

pnpm v11 treats packages published into local Verdaccio as newly published packages.
For closed-network consumers that install trusted project lockfiles, configure pnpm to
trust those lockfiles:

```bash
pnpm config set --global trustLockfile true
```

For consumers that need to install without a trusted lockfile or update lockfiles inside
the closed network, disable pnpm's release-age quarantine instead:

```bash
pnpm config set --global minimumReleaseAge 0
```

Native packages may also run install scripts that fetch assets outside the npm
registry. For example, packages using `prebuild-install || node-gyp rebuild` can try
GitHub releases first and `nodejs.org` headers next. In closed networks, either mirror
those native assets or force source builds with local Node headers:

```bash
export npm_config_build_from_source=true
export npm_config_nodedir=/opt/nodejs
export NPM_CONFIG_BUILD_FROM_SOURCE=true
export NPM_CONFIG_NODEDIR=/opt/nodejs
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873
pnpm approve-builds
```

For a persistent setting, put `build-from-source=true` and `nodedir=/opt/nodejs` in the
project `.npmrc`; recent pnpm versions reject those keys in global `config.yaml`.
Keep the same environment active when running `pnpm approve-builds`, because approve
can run deferred native build scripts.

See [Workflows](./docs/workflows.md) for more detail.

## Development

```bash
npm ci
npm run build
npm run check
```

For a source checkout that is copied through Git, this refreshes the checkout, installs
dependencies, rebuilds, and opens the CLI/menu:

```bash
npm run update:run
```

Useful commands:

```bash
npm run build       # Type-check and build dist/
npm run cli         # Run the built CLI from this source checkout
npm run update:run  # Pull, install, build, then run the CLI
npm test            # Run tests
npm run lint        # Run ESLint
npm run format      # Format source and docs
npm run check       # Lint, type-check, tests, and knip
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
