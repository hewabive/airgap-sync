# airgap-sync

[![CI](https://github.com/hewabive/airgap-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/hewabive/airgap-sync/actions/workflows/ci.yml)

Synchronize Git repositories, npm packages, and Python applications across an air gap
using removable media.

The intended workflow is simple for the operator:

1. On an online machine, run **Download updates** to refresh configured Git repositories,
   discover their Node dependency graph, and download the required npm packages and Git
   dependency mirrors into `airgap-bundle/`.
2. Move the removable media into the closed network.
3. Run **Publish updates** to populate the closed-network npm registry and Gitea
   package/Git services through normal publication APIs.
4. Consumer machines install normally from the closed-network services:

```bash
npm ci --registry http://verdaccio.local:4873
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873
python3.11 -m pip install \
  --index-url http://gitea.local/api/packages/airgap-packages/pypi/simple \
  --only-binary=:all: --no-deps --require-hashes \
  -r requirements.lock
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
- application-first Python planning with automatic CPython-minor selection, broad
  Windows/Linux x86-64 coverage, inferred glibc boundaries, immutable per-platform
  locks, and Gitea Generic Package consumer contracts;
- Git dependency discovery and mirroring;
- npm publish with temporary tags, dist-tag restoration, and bundled `latest` handling;
- Gitea repository creation or publishing to already-created Git repositories;
- static bundle validation and temporary install verification for configured
  Git/Python application targets;
- append-only download and publish run reports under `airgap-bundle/runs/`.

Remaining real-environment validation focuses on large repositories, private
authentication variants, slow removable media, and suitable KTransformers hardware.

## Requirements

- Node.js 22 or newer
- npm 11 or newer
- Git
- Online side: access to source npm/Python registries and upstream Git hosts
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

Existing schema-v1 workspaces are validated and migrated automatically when opened.
The exact original configuration is retained as `airgap-sync.json.v1.backup`; no
manual migration command is required.

The menu covers the normal workflow:

- **Targets**: add, remove, configure, or download one Git/npm/Python application
  target.
- **Download updates**: run the online collection phase.
- **Publish updates**: publish the bundle into the closed-network registry and Git host.
- **Verify installs**: run package-manager installs for configured Git targets.
- **Diagnostics**: inspect, validate, and summarize the bundle.
- **Settings**: configure endpoints, Python application publication/coverage, defaults,
  and saved credentials. Exact environments and raw PyPI seeding remain under
  Advanced/Legacy.

The same workflow can be scripted:

```bash
# First setup on the portable drive.
npm exec -- airgap-sync init
npm exec -- airgap-sync target add git https://github.com/acme/app.git --branch main
npm exec -- airgap-sync target add npm eslint@latest
npm exec -- airgap-sync target add python-app orjson --coverage desktop-x64

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

When a project pins pnpm through `packageManager` or `devEngines.packageManager`,
download also includes both the Node-based `pnpm` package and the standalone
`@pnpm/exe` bootstrap closure. Toolchain declarations are scanned even when the
adjacent `package.json` is otherwise covered by a lockfile. A pnpm lockfile's
`packageManagerDependencies` remain authoritative for ranged `devEngines` declarations.

For Windows operators who prefer a double-click workflow, optional launchers live in
[`support/windows`](./support/windows). Copy them to the online and closed-network
machines; they find the removable drive workspace automatically. The download launcher
updates and rebuilds the source checkout before running `download`; the publish
launcher only runs the already-built `publish` command.

## Python Applications

New workspaces use schema v2 and default to broad Windows/Linux x86-64 coverage. The
normal workflow asks for an application and coverage, not Python patch versions,
distributions, manylinux tags, CPU/GPU inventory, or a resolver:

```bash
npm exec -- airgap-sync target add python-app ktransformers \
  --coverage desktop-x64 \
  --feature accelerator=cuda
npm exec -- airgap-sync download
```

Automatic selection chooses one compatible Python minor. To prepare the same
application for several consumer runtimes, repeat `--python-version`:

```bash
npm exec -- airgap-sync target add python-app vllm \
  --coverage desktop-x64 \
  --python-version 3.12 \
  --python-version 3.13
```

All requested minors must resolve to the same application version with a complete
wheel-only closure. Each platform/minor branch receives its own hash-complete lock.

`download` automatically creates a missing plan or replaces one made stale by target,
coverage, or recipe changes. A current plan is reused. Planning uses a pinned,
hash-verified `uv` executable but remains independent of the collector platform. Every
requested branch must resolve with wheels only; otherwise no partial plan is activated.
Narrowing the target is explicit:

```bash
npm exec -- airgap-sync target add python-app ktransformers \
  --platform linux-glibc-x86_64 \
  --feature accelerator=cuda
```

KTransformers has a maintained workspace-local recipe. The reviewed release has a
complete Linux wheel closure with an inferred glibc 2.35 floor, while its `kt-kernel`
dependency has no native Windows wheel. Broad coverage therefore reports Windows as
unsupported instead of silently publishing Linux only. Model weights are separate
application data and are not included as PyPI dependencies.

The separate `plan` command is optional advanced workflow for reviewing resolution
before downloading, using a fixed `--cutoff`, or explicitly refreshing an otherwise
current plan.

After `download` and closed-network `publish`, applications are available through the
standard Gitea PyPI Simple API. CPython runtime transfer is enabled by default;
airgap-sync publishes the verified archives so the stable Generic Package URL
`<gitea>/api/packages/<owner>/generic/python-build-standalone` can be passed directly
to `uv python install --mirror`. Because uv embeds its Python download catalog, the
workspace records covered consumer versions in `python.artifactTransfer.uvVersions`;
an unreviewed version fails planning instead of yielding a mirror that looks complete
but returns 404. The generated locks and consumer contracts document and verify bundle
coverage; consumers may still resolve a newly selected application version from the
repository. System packages remain consumer prerequisites.

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
.airgap-sync/             Active Python plans and workspace-local recipes
airgap-bundle/            Transfer bundle
```

`airgap-sync.json` is long-lived workspace state. It stores configured targets and
defaults for download, publish, and install verification. It is meant to move with the
bundle between machines. Git repository provisioning defaults to
`defaults.publish.provisionGit: true`; set it to `false` when repositories are managed
externally, or to `"ask"` to prompt on each interactive publish.

`airgap-sync.secrets.json` is optional. If you save a Gitea token from the menu, it is
stored there in plaintext on the removable media.

One Gitea token is reused for Git, PyPI, and Generic Packages. The default Python
publication profile uses a managed public `airgap-packages` organization; publish
creates it when missing. Optional PyPI/Generic owner overrides do not require separate
tokens, and user accounts are never created automatically.

The bundle contains the current transferable state plus audit reports:

```text
airgap-bundle/packages/                 npm tarballs
airgap-bundle/python-packages/          Python wheels
airgap-bundle/python/application-index.json
airgap-bundle/python/applications/      Destination-neutral plans and locks
airgap-bundle/python/artifacts/         Shared content-addressed Python artifacts
airgap-bundle/python/publications/      Closed-side publication manifests and consumer configs
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
application branch, the command creates a temporary venv and runs the generated exact
closed-index lock plus `pip check` and reviewed health checks. Otherwise the Python
check is recorded as skipped. Production Python provisioning and installation remain
outside `airgap-sync`.

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
npm run e2e:ktransformers # Live pinned-uv KTransformers planning check
npm run benchmark:python-bundle -- /media/USB/airgap-bundle
```

## Documentation

- [Architecture](./docs/architecture.md)
- [CLI Reference](./docs/cli.md)
- [Bundle Format](./docs/bundle-format.md)
- [Development Guide](./docs/development.md)
- [Workflows](./docs/workflows.md)
- [Changelog](./CHANGELOG.md)
- [Security Policy](./SECURITY.md)
- [Python Application Security Review](./docs/python-application-security-review.md)

## License

MIT
