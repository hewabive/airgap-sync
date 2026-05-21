# CLI Contract

The final CLI should keep fetch and publish separate so the online and offline phases
are auditable.

## fetch

```bash
airgap-sync fetch react@latest @types/node@^22 \
  --output ./seed \
  --registry https://registry.npmjs.org

# Or from a project manifest. The manifest directory is scanned recursively for nested
# package.json files, excluding node_modules and build/cache directories.
airgap-sync fetch --manifest ./package.json \
  --output ./seed
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

When `--manifest` points at a package.json, the containing directory is treated as the
scan root. When it points at a directory, that directory is the scan root. Nested
package.json files are included so monorepositories can be seeded from the repository
root. Local workspace dependencies are skipped when their package names are discovered
inside the same scan root.

## publish

```bash
airgap-sync publish ./seed \
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
airgap-sync info ./seed
```

Prints a JSON summary with package counts, package names, restored tags, report status,
missing tarball files, and bundle validation issues.

## git plan

```bash
airgap-sync git plan ./seed \
  --gitea http://gitea.local \
  --owner npm-mirrors \
  --write
```

Reads `fetch-report.json`, groups discovered Git dependency specs by source
repository, and creates a deterministic mirror plan for Gitea. `--write` stores the
plan as `git-plan.json` inside the bundle; without it, the command only prints JSON.

The plan is intentionally non-mutating: it does not clone repositories, create Gitea
projects, or patch package manifests. It records source clone URLs, target Gitea URLs,
the npm packages that required each Git dependency, and candidate `insteadOf` prefixes
for a later apply/verify phase.

## git fetch

```bash
airgap-sync git fetch ./seed
airgap-sync git fetch ./seed --dry-run
airgap-sync git fetch ./seed --mirrors-dir ./git-mirrors
```

Reads `git-plan.json` and stores local bare mirror repositories. Missing mirrors are
created with `git clone --mirror`; existing mirrors run `git remote set-url origin` and
`git remote update --prune`. The command writes `git-fetch-report.json`.

This is the online-side collection step only. It does not push to Gitea; that belongs
to a later offline apply command.

## git apply

```bash
airgap-sync git apply ./seed
airgap-sync git apply ./seed --dry-run
airgap-sync git apply ./seed --mirrors-dir ./git-mirrors
```

Reads `git-plan.json` and pushes local bare mirrors to the planned Gitea target URLs
with `git push --mirror`. The target repositories must already exist unless the Gitea
instance is configured to create repositories on push.

The command writes `git-apply-report.json`, including generated `git config --global
url.*.insteadOf` commands for redirecting installs from public Git URLs to Gitea.

## git create-repos

```bash
airgap-sync git create-repos ./seed --token "$GITEA_TOKEN"
airgap-sync git create-repos ./seed --owner-type org --dry-run
airgap-sync git create-repos ./seed --public
```

Reads `git-plan.json` and creates missing repositories in Gitea before `git apply`.
The Gitea base URL and owner are taken from the plan. Tokens can be passed through
`--token` or `GITEA_TOKEN`; no token is required for `--dry-run`.

By default repositories are created as private user repositories. Use `--owner-type org`
when the plan owner is a Gitea organization, and `--public` when mirrors should not be
private.

## git config

```bash
airgap-sync git config ./seed --global
airgap-sync git config ./seed --global --dry-run
```

Reads `git-plan.json` and writes the generated URL rewrite rules into the global Git
configuration with `git config --global url.<gitea-url>.insteadOf <public-url>`. The
command writes `git-config-report.json`.
