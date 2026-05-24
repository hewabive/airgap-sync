# Workflows

This document describes the end-to-end workflow. `download` handles the online side, and
`publish` handles the closed-network import side. Lower-level commands remain available
for debugging individual phases.

## Assumptions

- The online machine can reach the source npm registry and public Git hosts.
- Project Git repositories are on removable media or in a directory that can be
  refreshed on the online machine.
- The transfer bundle directory is on removable media or can be copied to it.
- The closed network has Verdaccio and Gitea running.
- Verdaccio is populated only through `npm publish` and `npm dist-tag`.
- Verdaccio, and any reverse proxy in front of it, allows large package uploads. Large
  native packages can fail with HTTP `E413` unless Verdaccio `max_body_size` and proxy
  upload limits are raised.
- Gitea target repositories either can be created through the Gitea API or already
  exist.

Example names used below:

```text
./airgap-bundle                 Transfer bundle directory
https://registry.npmjs.org      Source npm registry
http://verdaccio.local:4873     Closed-network npm registry
http://gitea.local              Closed-network Gitea base URL
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
reuse previous bundle mappings. When the interactive menu initializes a workspace, it
asks for these defaults during setup.
If the operator saves a Gitea token, it is stored separately in
`airgap-sync.secrets.json`, which is ignored by Git but remains plaintext on the
removable media.

## Online Phase

Refresh configured targets and download npm/Git dependency closure:

```bash
airgap-sync download
```

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

By default, download uses `latestPolicy: "bundled"`: for each package name in the
bundle, `latest` is restored to the newest version already present in that bundle. Use
`latestPolicy: "source"` or `airgap-sync download --latest-policy source` when the
bundle should also fetch the source registry's current `latest` version for every
included package name.

When publishing a `bundled` latest decision, `airgap-sync` will not downgrade an
existing Verdaccio `latest` that already points to a newer semver version. Explicit tags
from real package specs are still restored exactly.

By default, download also uses `tagResolutionPolicy: "reuse-stable"`. If a dependency
tag such as `node-fetch@cjs` was already mapped in the previous bundle for the same
declaring parent, and that parent did not change, the old mapped version is reused.
Use `--tag-resolution-policy refresh` when every tag dependency should be checked
against the source registry during this run.

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

Do not copy only tarballs. The JSON files are the audit trail and are required by later
commands.

## Offline Phase

Publish the bundle to Verdaccio and Gitea:

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
- map source Git repositories to the closed-network Gitea instance;
- preserve upstream owner/repository paths when possible;
- create missing Gitea owners or repositories;
- push local bare mirrors into Gitea using the provided Gitea token;
- generate install configuration for consumer machines.

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
