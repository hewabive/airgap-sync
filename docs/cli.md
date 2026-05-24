# CLI Reference

The CLI keeps download and publish phases separate so the online and offline phases are
auditable.

The preferred user workflow is workspace-based: initialize a directory on removable
media, add Git/npm targets once, then run `download` online and `publish` offline.

## init

```bash
airgap-sync init
airgap-sync init /media/USB/airgap-sync
```

Creates `airgap-sync.json` plus the default workspace directories:

```text
airgap-bundle/
```

The default config uses `https://registry.npmjs.org` and `./airgap-bundle`.

## target

```bash
airgap-sync target add git https://github.com/acme/app.git --branch main
airgap-sync target add npm eslint@latest
airgap-sync target list
airgap-sync target remove 1
```

Targets are stored in `airgap-sync.json`. Git targets are fetched as bare mirrors into
`airgap-bundle/git-mirrors/` during `download`. npm targets are treated as explicit root
package specs.

## menu

```bash
airgap-sync
airgap-sync menu
airgap-sync menu /media/USB/airgap-sync
```

Opens an interactive prompt menu for common workspace actions. The top level keeps the
regular workflow compact: targets, download, publish, install verification, diagnostics,
and settings. Target management, bundle checks, bundle info, and saved credentials
live in submenus.

Running `airgap-sync` without a subcommand opens this menu. Use `airgap-sync -h` or a
specific command's `-h` option for non-interactive help.

The menu is intentionally a thin wrapper over the normal CLI commands. It stores
`targetRegistry`, `giteaUrl`, bundle output, and default answers in `airgap-sync.json`.
When the menu initializes a new workspace, it asks for these values up front.
Default answers live under `defaults.download`, `defaults.publish`, and
`defaults.verifyInstall`. Boolean defaults can be `yes`, `no`, or `ask`; `ask` keeps
the prompt for that action. `defaults.download.latestPolicy` is either `bundled` or
`source`; `defaults.download.tagResolutionPolicy` is either `reuse-stable` or
`refresh`.
Gitea tokens are stored only when explicitly requested, in `airgap-sync.secrets.json`.

## secrets

```bash
airgap-sync secrets status
airgap-sync secrets set-gitea-token
airgap-sync secrets check-gitea-token
airgap-sync secrets clear-gitea-token
```

Manages local workspace secrets in `airgap-sync.secrets.json`. This file is ignored by
Git and is separate from `airgap-sync.json`, but it is still plaintext on the removable
media. A saved Gitea token is used by `publish`, `git create-repos`, and `git apply` when
no command-line token or `GITEA_TOKEN` environment variable is provided.

## repos update

```bash
airgap-sync repos update ./repos
airgap-sync repos update ./repos --dry-run
```

Scans a directory for Git repositories and refreshes each clean branch with
`git pull --ff-only`. Dirty worktrees, detached HEADs, non-fast-forward branches, and
authentication failures are reported without automatic repair.

## download

```bash
airgap-sync download

# Lower-level mode without airgap-sync.json:
airgap-sync download ./repos \
  --registry https://registry.npmjs.org \
  --include-dev \
  --latest-policy bundled \
  --tag-resolution-policy reuse-stable \
  --concurrency 16 \
  --output ./airgap-bundle
```

Without a root argument, reads `airgap-sync.json` from the current directory, fetches
configured Git targets as bare mirrors, scans package manifests from those mirrors,
includes configured npm targets as root package specs, resolves npm registry packages,
writes portable Git source metadata, clones or updates Git dependency mirrors, scans
package manifests from those mirrors, and repeats until no new npm or Git inputs are
found. It also writes `workspace-snapshot.json` with the configured targets and their
bundle-local mirror paths for later verification.

With an explicit root argument, keeps the lower-level behavior and scans that directory
directly.

`--latest-policy bundled` is the default. It records `latest` as the newest version
already included in the bundle for each package name. `--latest-policy source` also
resolves and downloads the source registry's `latest` for each included package name.

`--tag-resolution-policy reuse-stable` is the default. It reuses a previous
`dist-tags.json` tag mapping only when the same `name + tag + requiredBy` existed in the
previous bundle and the mapped package tarball is still present. Root tag targets are
always resolved from the source registry. `--tag-resolution-policy refresh` resolves
all tag dependencies from the source registry.

Use `reuse-stable` for one linear update stream where the bundle is the only source of
Verdaccio updates. If the same registry is updated through other paths or independently
generated bundles, prefer `refresh`; reused dependency tags are restored strictly and
can move shared registry tags backward.

`--concurrency` controls parallel npm resolve/download workers. The default is `16`.

The online bundle should store Git source identities and local mirrors, not
Gitea-specific target URLs.

## fetch

```bash
airgap-sync fetch react@latest @types/node@^22 \
  --output ./airgap-bundle \
  --registry https://registry.npmjs.org \
  --latest-policy bundled \
  --tag-resolution-policy reuse-stable \
  --concurrency 16

# Or from a project manifest. The manifest directory is scanned recursively for nested
# package.json files, excluding node_modules and build/cache directories.
airgap-sync fetch --manifest ./package.json \
  --output ./airgap-bundle
```

Supported options:

```text
<spec...>                  Package specs to seed, e.g. react@latest
-o, --output <dir>        Bundle output directory
-r, --registry <url>      Source registry URL
--manifest <path>         Read dependencies from a package.json or directory
--include-dev             Include devDependencies from discovered manifests
--include-peer            Traverse peerDependencies
--latest-policy <policy>  Latest dist-tag policy: bundled or source
--tag-resolution-policy <policy>
                          Tag dependency policy: reuse-stable or refresh
--concurrency <number>    Concurrent registry and download operations
--dry-run                 Resolve and report without downloading
```

At least one package spec or `--manifest` is required.

`--dry-run` performs the same dependency traversal as a normal fetch, including
transitive dependencies and publish-time `latest` targets required by the selected
latest policy, but reads package manifests from registry metadata without downloading
tarballs.

`--concurrency` controls parallel npm resolve/download workers. The default is `16`.

When `--manifest` points at a package.json, the containing directory is treated as the
scan root. When it points at a directory, that directory is the scan root. Nested
package.json files are included so monorepositories can be seeded from the repository
root. Local workspace dependencies are skipped when their package names are discovered
inside the same scan root.

## npm publish

```bash
airgap-sync npm publish ./airgap-bundle \
  --registry http://192.168.0.10:4873
```

Supported options:

```text
-r, --registry <url>      Target registry URL
--dist-tag-concurrency <n> Concurrent npm dist-tag operations, default 4
--publish-concurrency <n> Concurrent npm publish operations, default 4
--no-skip-existing        Attempt to publish versions that already exist
--dry-run                 Print planned operations without publishing
```

Current behavior publishes tarballs with a temporary tag, then restores the required
tags from `dist-tags.json`. Before running npm publish commands, it validates that
bundle manifests are internally consistent and every referenced tarball exists.

## info

```bash
airgap-sync info ./airgap-bundle
```

Prints a JSON summary with package counts, package names, restored tags, report status,
missing tarball files, and bundle validation issues.

## verify

```bash
airgap-sync verify ./airgap-bundle
airgap-sync verify ./airgap-bundle --json
airgap-sync verify install ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local \
  --ignore-scripts
```

Checks the bundle without running package-manager installs. It validates bundle
manifests and tarballs, checks fetch and collect reports, verifies
`workspace-snapshot.json`, checks Git mirror presence from `git-sources.json`, and
checks `apply-report.json` when present. The command writes `verify-report.json`.

Errors produce a non-zero exit code. Warnings, such as a missing `apply-report.json`
before the offline import has run, are reported but do not fail the command.

`verify install` runs real package-manager installs for Git targets recorded in
`workspace-snapshot.json`. It checks out each target project from the bundle-local Git
mirror into a temporary directory, detects the package manager from the lockfile, sets
the npm registry, and uses a temporary Git config with source-host rewrites to the
provided Gitea URL. It writes `verify-install-report.json`.

By default `verify install` runs the same lifecycle scripts that a normal install
would run. Add `--ignore-scripts` to check dependency resolution and Git/npm
rewrites without running package scripts.

Supported install detection:

```text
pnpm-lock.yaml      pnpm install --frozen-lockfile
package-lock.json   npm ci
yarn.lock           yarn install --immutable
```

With `--ignore-scripts`, npm and pnpm receive `--ignore-scripts`; Yarn receives
`--mode=skip-builds`.

Projects without a supported lockfile are skipped.

## git sources

```bash
airgap-sync git sources ./airgap-bundle
airgap-sync git sources ./airgap-bundle --write
```

Creates portable `git-sources.json` metadata from `fetch-report.json` without binding
the bundle to a Gitea instance. Source records preserve upstream host and
owner/repository paths, for example `github.com/antvis/G2`, and point at local mirror
paths such as `git-mirrors/github.com/antvis/G2.git`.

## git fetch

```bash
airgap-sync git fetch ./airgap-bundle
airgap-sync git fetch ./airgap-bundle --dry-run
airgap-sync git fetch ./airgap-bundle --mirrors-dir ./git-mirrors
```

Reads `git-sources.json` and stores local bare mirror repositories using preserved
source paths such as `git-mirrors/github.com/antvis/G2.git`. Missing mirrors are
created with `git clone --mirror`; existing mirrors run `git remote set-url origin` and
`git remote update --prune`. The command writes `git-fetch-report.json`.

This is the online-side download step only. It does not push to Gitea; that belongs
to a later offline publish command.

## git apply

```bash
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local --dry-run
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local --mirrors-dir ./git-mirrors
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local --token "$GITEA_TOKEN"
```

Reads `git-sources.json` and pushes local bare mirrors to Gitea with
`git push --mirror`. Target URLs preserve upstream owner/repository paths: for example
`https://github.com/antvis/G2.git` maps to `http://gitea.local/antvis/G2.git`.
The target repositories must already exist unless the Gitea instance is configured to
create repositories on push.

When `--token`, `GITEA_TOKEN`, or a saved token is available, the command uses it for
Git HTTP push authentication instead of relying on an interactive credential helper.

The command writes `git-apply-report.json`, including generated `git config --global
url.*.insteadOf` commands for redirecting installs from public Git URLs to Gitea.

## git create-repos

```bash
airgap-sync git create-repos ./airgap-bundle --gitea http://gitea.local --token "$GITEA_TOKEN"
airgap-sync git create-repos ./airgap-bundle --gitea http://gitea.local --dry-run
airgap-sync git create-repos ./airgap-bundle --gitea http://gitea.local --public
```

Reads `git-sources.json` and creates missing repositories in Gitea before
`git apply`. Tokens can be passed through `--token`, `GITEA_TOKEN`, or saved secrets;
no token is required for `--dry-run`.

By default repositories are created as private organization repositories, preserving
the original owner name as the Gitea organization. Missing organizations are created
before repositories. Use `--public` when mirrors should not be private.

## git config

```bash
airgap-sync git config ./airgap-bundle --gitea http://gitea.local --global
airgap-sync git config ./airgap-bundle --gitea http://gitea.local --global --dry-run
```

Reads `git-sources.json` and writes host-wide rewrite rules into the global Git
configuration, for example
`git config --global url.http://gitea.local/.insteadOf https://github.com/`. The command
writes `git-config-report.json`.

## publish

```bash
airgap-sync publish ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local
```

Publishes the whole bundle in the closed network: publish npm packages to Verdaccio,
restore dist-tags, map Git sources to Gitea targets, create missing Gitea
owners/repositories, push mirrors, and write import reports.

Supported options:

```text
-r, --registry <url>      Target npm registry URL
--gitea <url>             Closed-network Gitea base URL
--gitea-token <token>     Gitea API token, defaults to GITEA_TOKEN or saved secrets
--mirrors-dir <dir>       Directory containing bare Git mirrors
--public                  Create public Gitea repositories instead of private repositories
--no-skip-existing        Attempt to publish npm versions that already exist
--dist-tag-concurrency <n> Concurrent npm dist-tag operations, default 4
--publish-concurrency <n> Concurrent npm publish operations, default 4
--configure-git-global    Write Git URL rewrite rules into global Git config
--dry-run                 Print planned publish operations without publishing or pushing
```

Prefer the `GITEA_TOKEN` environment variable or a saved token over `--gitea-token` so
the token does not appear in shell history or process listings.

The Gitea token is used for both API repository provisioning and Git HTTP mirror
push authentication.

Git target paths preserve source owner/repository names by default. For example,
`https://github.com/antvis/G2.git` maps to `http://gitea.local/antvis/G2.git`, so
consumer machines can use one broad `insteadOf` rule for the source host. `publish`
writes those rewrite rules into `git-apply-report.json`; it only mutates global Git
config when `--configure-git-global` is passed.
