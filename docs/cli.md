# CLI Contract

The final CLI should keep fetch and publish separate so the online and offline phases
are auditable.

The preferred user workflow is workspace-based: initialize a directory on removable
media, add Git/npm targets once, then run `collect` online and `apply` offline.

## init

```bash
airgap-sync init
airgap-sync init /media/USB/airgap-sync
```

Creates `airgap-sync.json` plus the default workspace directories:

```text
repos/
bundle/
cache/
reports/
```

The default config uses `https://registry.npmjs.org`, `./repos`, and `./bundle`.

## target

```bash
airgap-sync target add git https://github.com/acme/app.git --branch main
airgap-sync target add npm eslint@latest
airgap-sync target list
airgap-sync target remove 1
```

Targets are stored in `airgap-sync.json`. Git targets are cloned into `repos/` using
preserved source paths such as `repos/github.com/acme/app`. npm targets are treated as
explicit root package specs during `collect`.

## repos update

```bash
airgap-sync repos update ./repos
airgap-sync repos update ./repos --dry-run
```

Scans a directory for Git repositories and refreshes each clean branch with
`git pull --ff-only`. Dirty worktrees, detached HEADs, non-fast-forward branches, and
authentication failures are reported without automatic repair.

## collect

```bash
airgap-sync collect

# Lower-level mode without airgap-sync.json:
airgap-sync collect ./repos \
  --registry https://registry.npmjs.org \
  --include-dev \
  --concurrency 16 \
  --output ./airgap-bundle
```

Without a root argument, reads `airgap-sync.json` from the current directory, clones
missing configured Git targets into `repos/`, scans those repositories, includes
configured npm targets as root package specs, resolves npm registry packages, writes
portable Git source metadata, clones or updates Git dependency mirrors, scans package
manifests from those mirrors, and repeats until no new npm or Git inputs are found.
It also writes `workspace-snapshot.json` with the configured targets and portable
relative repository paths for later verification.

With an explicit root argument, keeps the lower-level behavior and scans that directory
directly.

`--concurrency` controls parallel npm resolve/download workers. The default is `16`.

The online bundle should store Git source identities and local mirrors, not
Gitea-specific target URLs.

## fetch

```bash
airgap-sync fetch react@latest @types/node@^22 \
  --output ./airgap-bundle \
  --registry https://registry.npmjs.org \
  --concurrency 16

# Or from a project manifest. The manifest directory is scanned recursively for nested
# package.json files, excluding node_modules and build/cache directories.
airgap-sync fetch --manifest ./package.json \
  --output ./airgap-bundle
```

Planned options:

```text
<spec...>                  Package specs to seed, e.g. react@latest
-o, --output <dir>        Bundle output directory
-r, --registry <url>      Source registry URL
--manifest <path>         Read dependencies from a package.json or directory
--include-dev             Include devDependencies from discovered manifests
--include-peer            Traverse peerDependencies
--concurrency <number>    Concurrent registry and download operations
--dry-run                 Resolve and report without downloading
--debug                   Verbose diagnostics
```

At least one package spec or `--manifest` is required.

`--dry-run` performs the same dependency traversal as a normal fetch, including
transitive dependencies and publish-time `latest` targets, but reads package manifests
from registry metadata instead of downloading tarballs.

`--concurrency` controls parallel npm resolve/download workers. The default is `16`.

When `--manifest` points at a package.json, the containing directory is treated as the
scan root. When it points at a directory, that directory is the scan root. Nested
package.json files are included so monorepositories can be seeded from the repository
root. Local workspace dependencies are skipped when their package names are discovered
inside the same scan root.

## publish

```bash
airgap-sync publish ./airgap-bundle \
  --registry http://192.168.0.10:4873
```

Planned options:

```text
-r, --registry <url>      Target registry URL
--concurrency <number>    Concurrent publish operations
--no-skip-existing        Attempt to publish versions that already exist
--dry-run                 Print planned operations without publishing
--debug                   Verbose diagnostics
```

Current MVP behavior publishes tarballs sequentially with a temporary tag, then restores
the required tags from `dist-tags.json`. Before running npm publish commands, it
validates that bundle manifests are internally consistent and every referenced tarball
exists.

## info

```bash
airgap-sync info ./airgap-bundle
```

Prints a JSON summary with package counts, package names, restored tags, report status,
missing tarball files, and bundle validation issues.

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

This is the online-side collection step only. It does not push to Gitea; that belongs
to a later offline apply command.

## git apply

```bash
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local --dry-run
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local --mirrors-dir ./git-mirrors
```

Reads `git-sources.json` and pushes local bare mirrors to Gitea with
`git push --mirror`. Target URLs preserve upstream owner/repository paths: for example
`https://github.com/antvis/G2.git` maps to `http://gitea.local/antvis/G2.git`.
The target repositories must already exist unless the Gitea instance is configured to
create repositories on push.

The command writes `git-apply-report.json`, including generated `git config --global
url.*.insteadOf` commands for redirecting installs from public Git URLs to Gitea.

## git create-repos

```bash
airgap-sync git create-repos ./airgap-bundle --gitea http://gitea.local --token "$GITEA_TOKEN"
airgap-sync git create-repos ./airgap-bundle --gitea http://gitea.local --dry-run
airgap-sync git create-repos ./airgap-bundle --gitea http://gitea.local --public
```

Reads `git-sources.json` and creates missing repositories in Gitea before
`git apply`. Tokens can be passed through `--token` or `GITEA_TOKEN`; no token is
required for `--dry-run`.

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

## apply

```bash
airgap-sync apply ./airgap-bundle \
  --registry http://verdaccio.local:4873 \
  --gitea http://gitea.local \
  --gitea-token "$GITEA_TOKEN"
```

Applies the whole bundle in the closed network: publish npm packages to Verdaccio,
restore dist-tags, map Git sources to Gitea targets, create missing Gitea
owners/repositories, push mirrors, and write apply reports.

Supported options:

```text
-r, --registry <url>      Target npm registry URL
--gitea <url>             Closed-network Gitea base URL
--gitea-token <token>     Gitea API token, defaults to GITEA_TOKEN
--mirrors-dir <dir>       Directory containing bare Git mirrors
--public                  Create public Gitea repositories instead of private repositories
--no-skip-existing        Attempt to publish npm versions that already exist
--configure-git-global    Write Git URL rewrite rules into global Git config
--dry-run                 Print planned apply operations without publishing or pushing
```

Git target paths preserve source owner/repository names by default. For example,
`https://github.com/antvis/G2.git` maps to `http://gitea.local/antvis/G2.git`, so
consumer machines can use one broad `insteadOf` rule for the source host. `apply`
writes those rewrite rules into `git-apply-report.json`; it only mutates global Git
config when `--configure-git-global` is passed.
