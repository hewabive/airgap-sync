# Workflows

This document describes the end-to-end workflow. `download` handles the online side, and
`publish` handles the closed-network import side. Lower-level commands remain available
for debugging individual phases.

## Assumptions

- The online machine can reach the source npm/Python registries and public Git hosts.
- Project Git repositories are on removable media or in a directory that can be
  refreshed on the online machine.
- The transfer bundle directory is on removable media or can be copied to it.
- The closed network has an npm-compatible registry and Gitea. Verdaccio and Gitea are
  the tested path; Gitea exposes the consumer-facing Python index.
- Python consumers are inside the declared CPython/platform compatibility envelope and
  use a standard client that reads the Gitea PyPI Simple API.
- The npm registry is populated only through `npm publish` and `npm dist-tag`.
- The registry, and any reverse proxy in front of it, allows large package uploads. Large
  native packages can fail with HTTP `E413` unless Verdaccio `max_body_size` and proxy
  upload limits are raised.
- Gitea target repositories either can be created through the Gitea API or already
  exist.

Example names used below:

```text
./airgap-bundle                 Transfer bundle directory
https://registry.npmjs.org      Source npm registry
http://verdaccio.local:4873     Closed-network npm registry
http://gitea.local              Closed-network Git host base URL
```

## First Setup

Create a workspace on removable media and describe the things that must stay fresh:

```bash
mkdir -p /media/USB/airgap-sync
cd /media/USB/airgap-sync
npm init -y
npm install airgap-sync --omit=dev
npm exec -- airgap-sync init

airgap-sync target add git https://github.com/acme/app.git --branch main
airgap-sync target add git https://github.com/acme/service.git
airgap-sync target add npm eslint@latest
airgap-sync target add npm typescript@latest
airgap-sync target add python-app orjson --coverage desktop-x64 \
  --python-version 3.10 --python-version 3.11 \
  --python-version 3.12 --python-version 3.13
airgap-sync target add cpython-distributions --from-minor 3.10 \
  --platform windows-x86_64 --platform linux-glibc-x86_64 \
  --latest 1 --window-days 365
airgap-sync target list
```

The examples below use `airgap-sync` directly. In a local npm install on removable
media, prefix the same commands with `npm exec --`.

Operators who prefer prompts can run:

```bash
airgap-sync
```

The menu covers target management, endpoint configuration, Python compatibility
coverage/publication, online download, offline publish, verification, and bundle info.
The initial Python ceiling is CPython 3.10–3.13 on Windows and glibc Linux x86-64.

The target list is stored in `airgap-sync.json`. It is intentionally editable JSON, so
operators can review or change the sync set without learning hidden state.
Keep this file in the workspace root on removable media, next to `airgap-bundle/`; it
is long-lived workspace state rather than a file inside one generated bundle. The same
file stores endpoint URLs, bundle output, and menu defaults; boolean defaults can be
set to `true`, `false`, or `ask` under `defaults.download`, `defaults.publish`, and
`defaults.verifyInstall`. `defaults.download.latestPolicy` controls whether artificial
`latest` tags are assigned to bundled versions or resolved from the source registry.
`defaults.download.tagResolutionPolicy` controls whether stable tag dependencies can
reuse previous bundle mappings. `defaults.download.rangeResolutionPolicy` controls
whether stable transitive semver range dependencies can reuse previous resolved
versions. `defaults.download.prune` controls whether stale local npm, Python, and Git
bundle objects are removed after a successful download. When the interactive menu
initializes a workspace, it asks for these defaults during setup.
`defaults.publish.provisionGit` defaults to `true`; set it to `false` to assume Git
repositories already exist, or to `"ask"` to choose on every interactive publish.
If the operator saves a Gitea token, it is stored separately in
`airgap-sync.secrets.json`, which is ignored by Git but remains plaintext on the
removable media.

Opening an older schema-v1 workspace automatically migrates it to the current schema
before the menu or command continues. The original file is retained as
`airgap-sync.json.v1.backup`, and reopening the workspace is a no-op. Use
`airgap-sync migrate --dry-run` only when a non-writing preview is useful.

New workspaces use schema v2 and store Python application intent separately from named
coverage policies. `python.planner` identifies the collector's internal resolver. The
target contract never asks operators to enumerate consumer package-manager versions;
consumer tools are separate applications and CPython uses its own distribution target.

`download` resolves every selected application across the requested platform/Python
envelope and follows each dependency tree down to its leaves. The ready condition is
stronger than producing a lock: ordinary clients must be able to install from an index
populated only with the bundle's artifacts. Shared wheels are stored once. The separate
`plan` command remains useful for review, size estimates, and explicit refresh.

`requirements*.txt`, `uv.lock`, and `pylock*.toml` inside Git repositories are not
Python application targets and are not scanned. Add a `python-app` target and a
maintained recipe when a repository tool needs explicit offline support.

## Online Phase

Refresh configured targets and download npm/Git dependency closure:

```bash
airgap-sync download
```

When only one configured application needs an urgent refresh, select its one-based
target index from `airgap-sync target list`:

```bash
airgap-sync target list
airgap-sync download --target 2
```

Partial target downloads update the shared bundle but skip pruning, even if pruning is
enabled in defaults, so dependencies for other configured targets are not removed.

For a one-time transfer, remove the application target after a successful publish. A
later full download plus prune removes its locally unreferenced wheels while preserving
anything still required by another active target. This has no effect on packages
already published to Gitea.

The download step fetches configured Git targets as bare mirrors under
`airgap-bundle/git-mirrors/`, scans package manifests from those mirrors, includes
configured npm targets as root package specs, and writes the transfer bundle under
`airgap-bundle/` by default. For Python applications it calculates bounded repository
coverage, downloads the deduplicated minimum wheel union, and retains planning evidence
and reports. Exact locks are audit artifacts; consumers are not expected to depend on
them.

Pinned pnpm is part of that closure. A `packageManager: pnpm@<version>` declaration
adds exact `pnpm` and `@pnpm/exe` roots. `devEngines.packageManager` ranges are resolved
only when no covering pnpm lockfile exists; otherwise the lockfile's exact
`packageManagerDependencies` entries are used. A root pnpm lockfile covers every nested
workspace manifest named by its `importers` section. This scan is independent of the
normal rule that lets a lockfile replace dependency scanning of a covered
`package.json`.

Lower-level collection from an explicit repository directory is still available:

```bash
airgap-sync download ./repos \
  --registry https://registry.npmjs.org \
  --include-dev \
  --output ./airgap-bundle
```

The download step runs to a fixed point:

```text
fetch configured Git targets into bundle-local mirrors
  -> scan package.json files from Git mirrors
  -> resolve and download npm registry package closure
  -> discover Git dependencies from package manifests
  -> clone/update missing Git dependency mirrors
  -> scan package.json files from newly mirrored Git repositories
  -> repeat until no new npm requirements or Git repositories appear
```

If new Git repositories are cloned, the node dependency collection must run again
before the bundle is complete.

The online bundle should not be tied to a specific closed-network Gitea URL. It should
store source Git identities such as `https://github.com/antvis/G2.git`, requested refs,
local mirror paths, and `requiredBy` edges. Mapping those sources to Gitea belongs to
the offline phase.

The download step writes npm metadata and Git source metadata:

- `seed-manifest.json`
- `dist-tags.json`
- `workspace-snapshot.json`
- `fetch-report.json`
- `npm-tarball-inspection-cache.json` as disposable SHA-256-keyed acceleration data
- package tarballs under `packages/`
- local bare Git mirrors under `git-mirrors/`
- Git source records for offline publish
- `python-seed-manifest.json` and `python-security-report.json` with the
  manifest-bound application wheels and exact-version PyPI OSV evidence
- `python/application-index.json`, per-application evidence, optional locks, and shared
  content-addressed artifacts for schema-v2 applications. These files contain no
  closed-network Gitea URL or package owner.

By default, download uses `latestPolicy: "bundled"`: publish computes `latest` from
`seed-manifest.json`, using the newest version already present in the bundle for each
package name. These computed latest decisions are not written to `dist-tags.json`. Use
`latestPolicy: "source"` or `airgap-sync download --latest-policy source` when the
bundle should also fetch the source registry's current `latest` version for every
included package name and record those tag requirements.

When publishing a `bundled` latest decision, `airgap-sync` will not downgrade an
existing Verdaccio `latest` that already points to a newer semver version. Explicit tags
from real package specs are still restored exactly.

By default, download also uses `tagResolutionPolicy: "reuse-stable"`. If a dependency
tag such as `node-fetch@cjs` was already mapped in the previous bundle for the same
declaring parent, and that parent did not change, the old mapped version is reused.
Use `--tag-resolution-policy refresh` when every tag dependency should be checked
against the source registry during this run.

Download also defaults to `rangeResolutionPolicy: "reuse-stable"`. If a transitive
dependency range such as `hono@^4.11.4` was previously resolved for the same declaring
parent, and that parent did not change, the old resolved version is reused while its
tarball remains in the bundle. If that exact parent mapping is absent, but the parent is
stable and the bundle already contains a version that satisfies the range, the highest
matching bundled version is reused. Root range targets are still explicit operator
requests and are resolved from the source registry. Use `--range-resolution-policy
refresh` when transitive ranges should float to the newest currently satisfying versions
during this run.

Independently of stable reuse, npm security defaults to
`vulnerabilityResolutionPolicy: "prefer-clean"`. If a selected unlocked SemVer range
version has an OSV finding, download checks a bounded set of compatible alternatives
and uses the newest one with no known findings. This may override an otherwise reusable
stable range mapping. Exact versions, dist-tags, and lockfile selections stay
authoritative. Use `"report-only"` when the bundle must preserve the ordinary resolver
choice and only inventory known vulnerabilities. Progress reports graph analysis and
tarball download as separate stages; the final graph is downloaded without resolving it
again.

Use `reuse-stable` when this workspace is the only source of Verdaccio updates and
imports are applied in order. Avoid it when the same Verdaccio is updated through other
paths or by independently generated bundles on different removable drives: reused tag
dependencies are restored strictly and can move a shared tag such as `latest` backward.
For mixed update sources, prefer `--tag-resolution-policy refresh` and
`--range-resolution-policy refresh`, and avoid importing older bundles after newer ones.

To keep removable media from growing indefinitely, prune stale local bundle objects
after a successful download:

```bash
airgap-sync download --prune
airgap-sync bundle prune ./airgap-bundle --dry-run
airgap-sync bundle prune ./airgap-bundle
```

Pruning removes tarballs, wheels, obsolete application plans, empty content-addressed
artifact directories, and Git mirrors that are no longer referenced by the latest
successful bundle documents. A full download writes an empty Python application index
when the last application target is removed, so those former plans and artifacts become
eligible for pruning. Shared Python artifacts remain while any application references
them. Prune refuses to run after an incomplete or partial target download and does not
delete anything from Verdaccio or Gitea.

Before transfer, inspect the bundle:

```bash
airgap-sync info ./airgap-bundle
airgap-sync verify ./airgap-bundle
```

Also check:

- `fetch-report.json` for unresolved registry packages and unsupported specs;
- Git source and fetch reports for clone/update errors.

## Transfer Phase

Copy the whole `./airgap-bundle` directory to the closed network, including:

- `packages/`
- `git-mirrors/`
- `seed-manifest.json`
- `dist-tags.json`
- `workspace-snapshot.json`
- `fetch-report.json`
- Git source metadata
- Git mirror fetch reports
- `python-seed-manifest.json`, `python-security-report.json`, and Python reports when
  present
- `python/` application evidence, reports, optional locks, and shared artifacts

Do not copy only tarballs. The JSON files are the audit trail and are required by later
commands.

## Offline Phase

Publish the bundle to the closed-network npm registry and Git host:

```bash
export GITEA_TOKEN=...

airgap-sync publish ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local \
  --gitea-token "$GITEA_TOKEN"
```

Instead of exporting `GITEA_TOKEN` every time, the closed-network operator can save it
once:

```bash
airgap-sync secrets set-gitea-token
```

The offline publish step should:

- publish npm tarballs into Verdaccio;
- restore npm dist-tags;
- map source Git repositories to the closed-network Git host;
- preserve upstream owner/repository paths when possible;
- resolve Git, PyPI, and optional Generic Package owners from the workspace profile;
- create missing Gitea organizations before any dependent upload (users are never
  created automatically);
- push local bare mirrors into Gitea using the provided Gitea token;
- query Gitea's compact PyPI Simple Index and skip exact version, filename, and SHA-256
  matches before uploading missing wheels through the PyPI API; a 409 triggers a
  metadata refresh and is accepted only when the existing file has the same SHA-256;
- preserve standard dependency metadata needed by ordinary PyPI clients;
- optionally publish plans, audit evidence, reports, or explicitly requested runtime
  artifacts through Gitea Generic Packages.

The PyPI endpoint is the normal consumer interface:

```bash
python -m pip install \
  --index-url http://gitea.local/api/packages/airgap-packages/pypi/simple \
  APP

uv pip install \
  --default-index http://gitea.local/api/packages/airgap-packages/pypi/simple \
  APP
```

Use this index as the primary `index-url`, not as an extra index, to avoid dependency
confusion and accidental access to the public internet.

The Git, PyPI, and optional Generic Package calls use the same Gitea token. By default
the PyPI repository uses the managed public `airgap-packages` organization. Generic
evidence publication is disabled by default; set `python.publication.publishEvidence`
and an optional `genericOwner` only when those internal documents are operationally
useful.

The PyPI owner may also receive packages from other `airgap-sync` workspaces or other
publishers. Publication is additive; this workflow neither inventories unrelated
packages nor attempts to make the destination match the local bundle exactly.

If Git repositories are created by another process, or the target Git host is not
Gitea-compatible, skip repository provisioning:

```bash
airgap-sync publish ./airgap-bundle \
  --registry http://registry.local:4873 \
  --gitea http://git.local \
  --skip-git-provision
```

For workspace-based runs, the persistent equivalent is:

```json
{
  "defaults": {
    "publish": {
      "provisionGit": false
    }
  }
}
```

For non-Gitea HTTP push authentication, pass explicit Git credentials:

```bash
airgap-sync publish ./airgap-bundle \
  --registry http://registry.local:4873 \
  --gitea http://git.local \
  --skip-git-provision \
  --git-username git \
  --git-password "$TOKEN"
```

By default `publish` reports the Git rewrite rules without changing global Git config.
Pass `--configure-git-global` on the import machine when that machine should also be
configured as a consumer.

For example:

```text
https://github.com/antvis/G2.git -> http://gitea.local/antvis/G2.git
```

This layout allows a broad consumer rewrite rule:

```bash
git config --global url."http://gitea.local/".insteadOf "https://github.com/"
```

Repository-specific `insteadOf` rules should be a fallback, not the default, because
they are harder to maintain on every consumer machine.

## Install Check

Run normal package-manager installs against the closed registries:

```bash
npm ci --registry http://verdaccio.local:4873
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873

python -m pip install \
  --index-url http://gitea.local/api/packages/airgap-packages/pypi/simple \
  APP

uv pip install \
  --default-index http://gitea.local/api/packages/airgap-packages/pypi/simple \
  APP
```

Python consumer infrastructure provides a CPython inside the published compatibility
envelope and any system prerequisites. `airgap-sync` does not create or manage that
production environment. `verify install` exposes only bundled wheels through a
temporary local Simple API and performs unlocked installs with pip and uv for a locally
matching planned cell. Static verification checks closure and compatible wheel
availability for all planned cells.

pnpm v11 applies `minimumReleaseAge: 1440` by default and verifies loaded lockfiles
unless `trustLockfile` is enabled. Because `airgap-sync` fills Verdaccio through
`npm publish`, imported packages look newly published to pnpm even when the original
npmjs.org release is old. On closed-network consumer machines that install trusted
project lockfiles, set:

```bash
pnpm config set --global trustLockfile true
```

If consumers intentionally install without a lockfile or update lockfiles inside the
closed network, either wait for the local publish age window to pass or explicitly set a
different policy, for example `minimumReleaseAge: 0` in pnpm configuration.

```bash
pnpm config set --global minimumReleaseAge 0
```

Native packages can still run install scripts that download non-npm artifacts. For
example, `better-sqlite3` runs `prebuild-install || node-gyp rebuild`: the first step
may fetch a prebuilt binary from GitHub releases, and the fallback build may fetch Node
headers from `nodejs.org`. These URLs are outside Verdaccio, so publishing npm tarballs
is not enough for this class of dependency.

If the closed-network machine has a compiler toolchain, prefer an explicit source build
and point `node-gyp` at local Node headers. For a Node installation rooted at
`/opt/nodejs`, run:

```bash
export npm_config_build_from_source=true
export npm_config_nodedir=/opt/nodejs
export NPM_CONFIG_BUILD_FROM_SOURCE=true
export NPM_CONFIG_NODEDIR=/opt/nodejs
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873
pnpm approve-builds
```

The equivalent persistent project configuration is a local `.npmrc` in the project or
workspace root:

```ini
build-from-source=true
nodedir=/opt/nodejs
```

Do not use `pnpm config set --global` for these two keys: recent pnpm versions store
global settings in a validated `config.yaml`, and `build-from-source`/`nodedir` are
npm/node-gyp passthrough options rather than pnpm settings.

Keep the same environment active when running `pnpm approve-builds`. pnpm can defer
native install scripts until approval, and those scripts need the same `node-gyp`
configuration that was used for `pnpm install`.

Use a `nodedir` that matches the Node version used for the install; otherwise native
addons may compile against the wrong ABI. If local headers are not available, bring the
matching Node headers into the closed network or provide an internal mirror through
`disturl`. If you prefer prebuilt binaries instead of source builds, mirror the package
release assets and configure the package-specific `prebuild-install` mirror or
`local_prebuilds` setting.

If install still tries to reach the public internet, inspect:

- Git errors: check Git source metadata, Gitea apply reports, and consumer rewrite
  configuration.
- Missing npm versions or tags: check `publish-report.json` and `dist-tags.json`.
- Unsupported specs: check `fetch-report.json`.

Before running project installs, verify the imported bundle:

```bash
airgap-sync verify ./airgap-bundle
airgap-sync verify install ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local \
  --ignore-scripts
```

## Current Lower-Level Commands

The current CLI also exposes lower-level commands for debugging:

```bash
# Online
airgap-sync fetch --manifest ./package.json --include-dev -o ./airgap-bundle
airgap-sync git sources ./airgap-bundle --write
airgap-sync git fetch ./airgap-bundle

# Offline
airgap-sync npm publish ./airgap-bundle --registry http://verdaccio.local:4873
airgap-sync git create-repos ./airgap-bundle --gitea http://gitea.local --token "$GITEA_TOKEN"
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local --token "$GITEA_TOKEN"
airgap-sync git apply ./airgap-bundle --gitea http://git.local --username git --password "$TOKEN"
airgap-sync git config ./airgap-bundle --gitea http://gitea.local --global
```

These commands are useful for testing individual phases. The bundle is not bound to a
Gitea instance during the online phase: `git-sources.json` records public source
identities, and the offline commands receive the local Gitea URL explicitly.

## Dry Runs

Most mutating Git steps support dry-run:

```bash
airgap-sync git fetch ./airgap-bundle --dry-run
airgap-sync git create-repos ./airgap-bundle --gitea http://gitea.local --dry-run
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local --dry-run
airgap-sync git config ./airgap-bundle --gitea http://gitea.local --global --dry-run
```

`airgap-sync npm publish ./airgap-bundle --dry-run --registry http://verdaccio.local:4873`
prints the planned npm publish and dist-tag operations without publishing.
`airgap-sync publish ./airgap-bundle --dry-run --registry http://verdaccio.local:4873 --gitea http://gitea.local`
plans the whole offline import without publishing, creating Gitea repositories, pushing
mirrors, or writing global Git config.

## Current Gaps

- `verify install` runs real installs with isolated package-manager caches, Git
  rewrites, and a bundle-only Python index, but it does not enforce a network-deny
  operating-system sandbox. Use
  `--ignore-scripts` when lifecycle scripts should not execute during verification.
- Dynamic Python install checks cover cells for which the verification host has a
  matching interpreter; a multi-OS/CPython integration matrix is still needed to
  execute every cell.
- CPython and package-manager executable transfer still need their own explicit target
  model if that optional capability is retained.
- Real-environment testing is still needed for large monorepositories, private source
  registries, private Git hosts, and authentication variants.
- Complex native applications, multiple source indexes, and explicit artifact variants
  need broader end-to-end fixtures. Model weights use a separate application-data
  transfer workflow.

Measure an actual large Python bundle directly on its removable-media mount:

```bash
npm run benchmark:python-bundle -- /media/USB/airgap-bundle --passes=2
```

The benchmark performs sequential reads plus SHA-256 validation. The first pass
captures media and cold-cache effects; later passes may be served by the OS cache. It
is a measurement report, not a hardware-independent pass/fail threshold.
