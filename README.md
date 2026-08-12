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
  APP
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
- npm dependency resolution, SRI/SHA-256 validation, release-age quarantine, OSV malware
  checks, lifecycle/non-registry dependency inspection, retries, and pruning;
- exact-version OSV malware checks for every collected PyPI package, with
  manifest-bound evidence required before Python publication;
- platform-aware Python application collection for Windows and glibc Linux x86-64,
  with explicit CPython 3.10–3.13 cells, minimum wheel coverage, inferred glibc
  boundaries, content-addressed storage, and Gitea PyPI publishing;
- rolling `python-build-standalone` CPython distribution collection with automatic
  stable-minor discovery, per-platform patch depth, build windows, local pruning, and
  additive Gitea Generic Package publication;
- static dependency-closure checks plus ordinary dependency-resolving `pip` and `uv`
  verification from a temporary index populated only with the collected bundle;
- Git dependency discovery and mirroring;
- npm publish with temporary tags, dist-tag restoration, and bundled `latest` handling;
- Gitea repository creation or publishing to already-created Git repositories;
- static bundle validation and temporary install verification for configured
  Git/Python application targets;
- append-only download and publish run reports under `airgap-bundle/runs/`.

Remaining Python work focuses on broader real-application and Gitea integration
coverage, additional distribution providers, and wider explicitly supported platform
envelopes.

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
`airgap-sync -h` for command help. During first-time setup, the initializer also asks
for an optional Gitea token and saves it for later publishing.

Existing schema-v1 workspaces are validated and migrated automatically when opened.
The exact original configuration is retained as `airgap-sync.json.v1.backup`; no
manual migration command is required.

The menu covers the normal workflow:

- **Targets**: add, edit, remove, or download one Git/npm/Python application or CPython
  distribution target. The editor exposes only settings supported by the selected type.
- **Download updates**: run the online collection phase.
- **Publish updates**: publish the bundle into the closed-network registry and Git host.
- **Verify installs**: run package-manager installs for configured Git targets.
- **Diagnostics**: inspect, validate, and summarize the bundle.
- **Settings**: configure endpoints, Python application publication, shared platform/Python
  defaults, and saved credentials.

The same workflow can be scripted:

```bash
# First setup on the portable drive.
npm exec -- airgap-sync init
npm exec -- airgap-sync target add git https://github.com/acme/app.git --branch main
npm exec -- airgap-sync target add npm eslint@latest
npm exec -- airgap-sync target add python-app orjson
npm exec -- airgap-sync target add cpython-distributions \
  --from-minor 3.10 \
  --platform linux-glibc-x86_64 --platform windows-x86_64 \
  --latest 3 --window-days 365

# Change the rolling policy later without removing the target.
npm exec -- airgap-sync target edit 4 \
  --from-minor 3.11 \
  --platform linux-glibc-x86_64 --platform windows-x86_64 \
  --latest 2 --window-days 30

# Online machine.
npm exec -- airgap-sync download --prune
npm exec -- airgap-sync download --target 2
npm exec -- airgap-sync verify ./airgap-bundle

# Closed-network machine.
# Uses targetRegistry/giteaUrl from airgap-sync.json and GITEA_TOKEN or a saved token.
npm exec -- airgap-sync publish

npm exec -- airgap-sync verify install ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local
```

After a global install, omit the `npm exec --` prefix.

When a project pins pnpm through `packageManager` or `devEngines.packageManager`,
download also includes both the Node-based `pnpm` package and the standalone
`@pnpm/exe` bootstrap closure. Toolchain declarations are scanned even when the
`package.json` is otherwise covered by a lockfile. A root pnpm lockfile covers nested
workspace manifests named by its `importers` section, and its
`packageManagerDependencies` remain authoritative for ranged `devEngines` declarations.

For Windows operators who prefer a double-click workflow, optional launchers live in
[`support/windows`](./support/windows). Copy them to the online and closed-network
machines; they find the removable drive workspace automatically. The download launcher
updates and rebuilds the source checkout before running `download`; the publish
launcher only runs the already-built `publish` command.

## Python Applications

The Python consumer interface is the Gitea PyPI Simple API. After publication,
consumer machines use ordinary standards-compatible clients and do not need to know
which resolver or transfer tool populated the registry:

```bash
python -m pip install \
  --index-url http://gitea.local/api/packages/airgap-packages/pypi/simple \
  APP

uv pip install \
  --default-index http://gitea.local/api/packages/airgap-packages/pypi/simple \
  APP
```

The initial maximum compatibility envelope is deliberately narrow:

- CPython 3.10–3.13;
- Windows x86-64;
- glibc-based Linux x86-64;
- wheels from PEP 503/691-compatible indexes.

Python applications inherit the workspace platform and Python matrix by default, so the
normal target contains only application-specific intent:

```bash
npm exec -- airgap-sync target add python-app APP
npm exec -- airgap-sync download
```

The shared envelope is stored under `python.applicationDefaults`. A target may override
its coverage with `--coverage`/`--platform` or its runtime with `--python-version`/
`--python`. `target edit --inherit-coverage --inherit-python` removes those overrides
and returns the application to the workspace defaults.

The envelope is a class of compatible machines, not host inventory. Platform coverage
is required, while configured Python minors are candidates: each minor with a complete
tree on every requested platform is bundled and incompatible minors are reported as
skipped. System packages, drivers, services, and model weights remain outside the
Python dependency bundle.

Collection is wheels-only. The implementation brings every selected dependency tree down
to its leaves, minimizes the union of wheels needed to cover the envelope, and verifies
ordinary resolution against an index populated only from the bundle. Universal and
`abi3` wheels are shared across compatible environments; content-identical files are
stored once.

As with npm, `airgap-sync` does not own the destination registry or promise a
reproducible resolver result. Multiple workspaces and other publishers may add packages
to the same Gitea owner. Removing a one-time target later prunes only locally
unreferenced bundle files; packages already published to Gitea remain available.

The implementation plans one dependency tree per declared compatibility cell, retains
the minimum practical wheel union covering those trees, and publishes the result to
Gitea PyPI. The collector's pinned `uv` is internal; normal targets do not ask for a
consumer `uv` version. Generated plans and locks are audit evidence, not the consumer
contract. A consumer package manager such as `uv` can be transferred as its own
ordinary Python application.

Portable CPython archives are a separate input. A `cpython-distributions` target tracks
stable CPython 3 minors from a fixed lower bound through the newest stable minor,
retains the configured latest patch depth independently for each platform, and applies
a provider-build window in exact days. These files are published additively to Gitea
Generic Packages and are never mixed into an application's PyPI dependency closure.
See [Python Support](./docs/python.md).

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
.airgap-sync/             Python planning evidence and workspace-local policy
airgap-bundle/            Transfer bundle
```

`airgap-sync.json` is long-lived workspace state. It stores configured targets and
defaults for download, publish, and install verification. It is meant to move with the
bundle between machines. Git repository provisioning defaults to
`defaults.publish.provisionGit: true`; set it to `false` when repositories are managed
externally, or to `"ask"` to prompt on each interactive publish.

The optional top-level `npmSecurity` object persists npm policy. Defaults are a
three-day release quarantine and a 72-hour security-report lifetime:

```json
{
  "npmSecurity": {
    "allowPackages": [],
    "maxReportAgeHours": 72,
    "minReleaseAgeDays": 3,
    "vulnerabilityResolutionPolicy": "prefer-clean"
  }
}
```

Lifecycle scripts are recorded because their presence is common and does not by itself
identify malicious code. The normal summary reports the complete inventory count but
warns only when an unapproved script is new or its exact package bytes or command have
changed since the previous successful scan. Non-registry dependencies remain blocking.
An optional acknowledgement or a reviewed exception pins the exact downloaded bytes as
`name@version#sha256:<hex>` in `allowPackages`; a changed tarball no longer matches.
Review a new lifecycle command before allowing install scripts to run. If it is
expected, copy the approval identity printed by `download` into
`npmSecurity.allowPackages`. For a new ordinary vulnerability, update the owning
application's dependency or lockfile and rerun download; unresolved findings should be
routed to that application's maintainer rather than silently accepted by the transfer
operator.
`maxReportAgeHours` is also the lifetime of Python OSV evidence; Python malware has no
allow-list escape hatch.

The release-age delay filters tags and SemVer ranges while an older compatible release
is available. If an exact version from a lockfile is younger than the delay, or a tag or
range has no eligible compatible alternative, airgap-sync keeps the resolved version so
the bundle remains installable and emits a non-blocking warning with the originating
repository, lockfile, or parent. Integrity, OSV, malware, and static package checks still
apply normally. These warnings are also recorded in `fetch-report.json`.

For unlocked SemVer ranges, the default `prefer-clean` policy checks the selected graph
with OSV before downloading tarballs and replaces a vulnerable selection when one of
the 20 newest compatible, release-age-eligible versions has no known OSV findings.
Exact versions, tags, and packages selected by lockfiles are never changed. Set
`vulnerabilityResolutionPolicy` to `report-only` to retain the resolver's original
selection and record vulnerabilities without attempting compatible substitutions. The
confirmed graph is then downloaded directly; it is not resolved a second time merely
to materialize its tarballs.

`airgap-sync.secrets.json` is optional. A Gitea token entered during interactive
first-time setup, or saved later from the menu, is stored there in plaintext on the
removable media. Leave the initial token prompt empty to configure it later. When
`GITEA_TOKEN` is already set, the initializer uses the environment value without
copying it into the secrets file.

One Gitea token is reused for Git, PyPI, and optional Generic Packages. The default
Python publication profile uses a managed public `airgap-packages` organization;
publish creates it when missing. Owner overrides do not require separate tokens, and
user accounts are never created automatically.

The bundle contains the current transferable state plus audit reports:

```text
airgap-bundle/packages/                 npm tarballs
airgap-bundle/python/application-index.json
airgap-bundle/python/applications/      Plans, resolver evidence, and optional locks
airgap-bundle/python/artifacts/         Shared content-addressed Python artifacts
airgap-bundle/python/distributions/     Rolling portable CPython distributions
airgap-bundle/python/publications/      Closed-side publication manifests and reports
airgap-bundle/git-mirrors/              bare Git mirrors
airgap-bundle/seed-manifest.json        bundled npm package versions
airgap-bundle/npm-tarball-inspection-cache.json disposable download acceleration data
airgap-bundle/security-report.json      OSV and static npm security evidence
airgap-bundle/security-delta.json       npm changes from the previous successful scan
airgap-bundle/python-seed-manifest.json bundled Python application wheels
airgap-bundle/python-security-report.json exact-version PyPI OSV evidence
airgap-bundle/python-security-delta.json Python changes from the previous successful scan
airgap-bundle/dist-tags.json            real dist-tag requirements
airgap-bundle/git-sources.json          Git source metadata
airgap-bundle/workspace-snapshot.json   targets for later verification
airgap-bundle/runs/                     append-only download/publish diagnostics
```

See [Bundle Format](./docs/bundle-format.md) for the full layout.

## Verification

`airgap-sync verify ./airgap-bundle` checks bundle consistency: manifests, referenced
tarballs and wheels, package identity and hashes, a fresh manifest-bound npm security
report, a fresh manifest-bound Python security report when Python packages are present,
reports, and Git metadata.

Within one download run, an npm tarball recorded by the previous schema-v2 manifest is
still streamed from disk and checked against its SHA-256 and resolved registry integrity.
When those bytes match, download can reuse its content-addressed cached `package.json`
instead of decompressing the archive again. New, changed, or uncached tarballs receive
a full archive inspection. A separate `verify` or `publish` command ignores this
disposable cache and starts a fresh full-content/archive check at that trust boundary.

`airgap-sync verify install ./airgap-bundle` runs real package-manager installs. For
Python applications it exposes only bundled wheels through a temporary local Simple
API, then performs unlocked `pip install APP==VERSION` and `uv pip install` checks with
fresh environments and caches. It verifies the locally matching compatibility cell;
the static verifier checks closure and wheel compatibility for every planned cell. It
does not enforce an operating-system network sandbox, so package lifecycle code is not
contained. Production Python provisioning remains outside `airgap-sync`.

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
- [Python Support](./docs/python.md)
- [CLI Reference](./docs/cli.md)
- [Bundle Format](./docs/bundle-format.md)
- [Development Guide](./docs/development.md)
- [Workflows](./docs/workflows.md)
- [Changelog](./CHANGELOG.md)
- [Security Policy](./SECURITY.md)
- [Python Repository Security Review](./docs/python-application-security-review.md)

## License

MIT
