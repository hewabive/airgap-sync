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
  the tested path; Gitea owns the anonymous consumer-facing Python index.
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
airgap-sync target add pypi 'requests==2.32.4'
airgap-sync target add python-wheel 'https://example/vllm-0.24.0+cpu-cp38-abi3-manylinux_2_34_x86_64.whl' --sha256 <digest>
airgap-sync target list
```

The examples below use `airgap-sync` directly. In a local npm install on removable
media, prefix the same commands with `npm exec --`.

Operators who prefer prompts can run:

```bash
airgap-sync
```

The menu covers target management, endpoint configuration, online download, offline
publish, verification, and bundle info.

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
versions. `defaults.download.prune` controls whether stale local bundle tarballs and Git
mirrors are removed after a successful download. When the interactive menu initializes a
workspace, it asks for these defaults during setup.
If the operator saves a Gitea token, it is stored separately in
`airgap-sync.secrets.json`, which is ignored by Git but remains plaintext on the
removable media.

Python support is enabled by adding explicit target environments. Full patch versions
and Linux compatibility levels are required so wheel selection never guesses the
consumer platform:

```json
{
  "gitOwnerStrategy": "preserve",
  "pythonSourceIndex": "https://pypi.org/simple/",
  "pythonPublishOwner": "pypi",
  "pythonResolutionMode": "locked-only",
  "pythonTargetEnvironments": [
    {
      "name": "prod-linux",
      "pythonVersion": "3.11.9",
      "os": "linux",
      "arch": "x86_64",
      "manylinux": "manylinux_2_17"
    }
  ]
}
```

`requirements*.txt`, `uv.lock`, and `pylock*.toml` are discovered in workspace
repositories and mirrored Git dependencies. `--include-dev` also includes development
requirements files and lock dependency groups. Direct URL, VCS, editable, path, sdist,
and extra-index inputs are intentionally reported as unsupported in this version.
Unlocked requirements and direct PyPI targets fail by default. Set
`pythonResolutionMode` to `approximate`, or pass `--allow-approximate-python` for one
run, to explicitly accept the simplified resolver without dependency backtracking.
An exact `python-wheel` target also needs this opt-in for its transitive metadata
closure, but the root itself is always pinned and verified by SHA-256. All resolved
wheels are published through the same Gitea PyPI owner during the offline phase.

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

The download step fetches configured Git targets as bare mirrors under
`airgap-bundle/git-mirrors/`, scans package manifests from those mirrors, includes
configured npm targets as root package specs, and writes the transfer bundle under
`airgap-bundle/` by default.

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
- package tarballs under `packages/`
- local bare Git mirrors under `git-mirrors/`
- Git source records for offline publish
- `python-seed-manifest.json`, `python-fetch-report.json`, and verified wheels under
  `python-packages/` when Python target environments are configured

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

Pruning removes tarballs, wheels, and Git mirrors that are no longer referenced by the
latest successful bundle documents. It refuses to run after an incomplete download and does
not delete anything from Verdaccio or Gitea.

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
- `python-packages/`, `python-seed-manifest.json`, and Python reports when present

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
- create missing Gitea owners or repositories;
- push local bare mirrors into Gitea using the provided Gitea token;
- generate install configuration for consumer machines.
- publish every bundled wheel under `pythonPublishOwner` through Gitea's PyPI upload
  API; a 409 is accepted only when the existing file has the same sha256.

For a public owner, consumers need no credentials:

```bash
export PIP_INDEX_URL=http://gitea.local/api/packages/pypi/pypi/simple
pip install --only-binary=:all: -r requirements.txt
```

Use this index as the primary `index-url`, not as an extra index, to avoid dependency
confusion and accidental access to the public internet.

If Git repositories are created by another process, or the target Git host is not
Gitea-compatible, skip repository provisioning:

```bash
airgap-sync publish ./airgap-bundle \
  --registry http://registry.local:4873 \
  --gitea http://git.local \
  --skip-git-provision
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

Run the normal package-manager install against Verdaccio:

```bash
npm ci --registry http://verdaccio.local:4873
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873
```

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

- `verify install` runs real installs with isolated package-manager caches and Git
  rewrites, but it does not yet enforce a network-deny sandbox. Use
  `--ignore-scripts` when lifecycle scripts should not execute during verification.
- Real-environment testing is still needed for large monorepositories, private source
  registries, private Git hosts, and authentication variants.
