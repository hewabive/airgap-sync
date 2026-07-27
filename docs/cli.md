# CLI Reference

The CLI keeps download and publish phases separate so the online and offline phases are
auditable.

The preferred user workflow is workspace-based: initialize a directory on removable
media, add Git/npm/Python application targets once, plan Python applications, then run
`download` online and `publish` offline.

## init

```bash
airgap-sync init
airgap-sync init /media/USB/airgap-sync
```

Creates a schema-v2 `airgap-sync.json`, broad Windows/Linux x86-64 Python coverage,
maintained workspace-local application recipes, and the default directories:

```text
.airgap-sync/recipes/
airgap-bundle/
```

The default config uses `https://registry.npmjs.org` and `./airgap-bundle`.

## target

```bash
airgap-sync target add git https://github.com/acme/app.git --branch main
airgap-sync target add npm eslint@latest

# Normal Python application workflow: Python is selected during download planning.
airgap-sync target add python-app ktransformers \
  --coverage desktop-x64 \
  --feature accelerator=cuda
airgap-sync target add python-app orjson \
  --platform windows-x86_64 \
  --platform linux-glibc-x86_64

# Advanced/legacy package seeding:
airgap-sync target add pypi 'requests==2.32.4' \
  --python-resolution-mode approximate
airgap-sync target add python-wheel \
  'https://github.com/vllm-project/vllm/releases/download/v0.24.0/vllm-0.24.0+cpu-cp38-abi3-manylinux_2_34_x86_64.whl' \
  --sha256 <64-hex-digest> \
  --python-resolution-mode approximate
airgap-sync target add python-runtime 3.12.13 \
  'https://github.com/astral-sh/python-build-standalone/releases/download/<build>/<archive>.tar.gz' \
  --sha256 <64-hex-digest>
airgap-sync target list
airgap-sync target set-python-resolution 1 approximate
airgap-sync target set-python-resolution 1 inherit
airgap-sync target remove 1
```

Targets are stored in `airgap-sync.json`. Git targets are fetched as bare mirrors into
`airgap-bundle/git-mirrors/` during `download`. npm targets are treated as explicit root
package specs. Git projects that pin pnpm through `packageManager` or
`devEngines.packageManager` automatically contribute `pnpm` and `@pnpm/exe` bootstrap
requirements; no separate npm target is needed.

`python-app` is the normal Python target. `--coverage` references a named workspace
policy; repeatable `--platform` creates target-local coverage instead. Python defaults
to automatic selection. `--python` is an advanced version constraint, `--extra`
selects package extras, `--feature name=value` records explicit application variants,
and `--recipe` selects reviewed workspace-local compatibility policy. Known maintained
applications may receive an installed recipe automatically.

Raw PyPI targets use PEP 508 requirement syntax and require an exact legacy target
environment. Git, PyPI, and exact root-wheel targets may set
`--python-resolution-mode locked-only|approximate`. With no target override they inherit
the workspace default. `target set-python-resolution <index> inherit` removes an
existing override. These controls are under Advanced/Legacy in the interactive menu.

## menu

```bash
airgap-sync
airgap-sync menu
airgap-sync menu /media/USB/airgap-sync
```

Opens an interactive prompt menu for common workspace actions. The top level keeps the
regular workflow compact: targets, download, publish, install verification, diagnostics,
and settings. Target management, Python applications, Advanced/Legacy seeding, bundle
checks, bundle info, and saved credentials live in submenus.

Running `airgap-sync` without a subcommand opens this menu. Use `airgap-sync -h` or a
specific command's `-h` option for non-interactive help.

The menu is intentionally a thin wrapper over the normal CLI commands. It stores
`targetRegistry`, `giteaUrl`, bundle output, Python application publication settings,
coverage, and default answers in `airgap-sync.json`. Initialization asks only whether
Python applications should cover Windows, Linux, or both; it does not ask for Python
versions, distributions, wheel tags, CPU/GPU inventory, or a resolver.

`Targets` → `Add Python application` is the normal flow. Raw PyPI targets, exact Python
environments, and resolution modes are under Advanced/Legacy. Python application
settings expose the source index, Gitea owners, and broad default coverage.
Default answers live under `defaults.download`, `defaults.publish`, and
`defaults.verifyInstall`. Boolean defaults can be `yes`, `no`, or `ask`; `ask` keeps
the prompt for that action. `defaults.download.latestPolicy` is either `bundled` or
`source`; `defaults.download.tagResolutionPolicy` and
`defaults.download.rangeResolutionPolicy` are either `reuse-stable` or `refresh`.
`defaults.download.prune` controls whether a successful download removes stale
tarballs and Git mirrors from the local bundle.
Gitea tokens are stored only when explicitly requested, in `airgap-sync.secrets.json`.

## coverage, plan, and probe

```bash
airgap-sync coverage list
airgap-sync coverage explain desktop-x64
airgap-sync plan
airgap-sync plan --update ktransformers
airgap-sync plan --cutoff 2026-07-27T00:00:00.000Z --json
airgap-sync probe --compare .airgap-sync/python-plans/<target>/environment-plan.json
```

`coverage` describes desired registry coverage, not a host inventory. The initial
families are Windows x86-64 and glibc Linux x86-64. Linux distribution names are
presentation hints; compatibility is derived from wheel tags and an inferred glibc
floor.

The normal `download` workflow invokes planning automatically when a plan is missing or
became stale after target, coverage, or recipe changes. The separate `plan` command is
an advanced entry point for resolving in advance, forcing an update, or supplying a
fixed `--cutoff`. Planning acquires the pinned collector-native `uv`, resolves every
requested target platform with wheels-only policy, selects a compatible CPython minor,
and stores an immutable active plan under `.airgap-sync/python-plans/`. Planning
succeeds only when every requested platform is complete. Unsupported coverage is
reported with suggestions to narrow the target, select another application version, or
supply a reviewed recipe/wheel.

`probe` is optional consumer diagnostics. It compares one machine to an existing plan
and collects only plan-referenced OS, architecture, libc/Python, and explicitly
requested capability facts.

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

airgap-sync download --target 2
airgap-sync download --target 2 --target 5

# Lower-level mode without airgap-sync.json:
airgap-sync download ./repos \
  --registry https://registry.npmjs.org \
  --include-dev \
  --latest-policy bundled \
  --tag-resolution-policy reuse-stable \
  --range-resolution-policy reuse-stable \
  --concurrency 8 \
  --registry-timeout-ms 120000 \
  --tarball-timeout-ms 300000 \
  --prune \
  --output ./airgap-bundle
```

Without a root argument, reads `airgap-sync.json` from the current directory, fetches
configured Git targets as bare mirrors, scans package manifests from those mirrors,
scans supported lockfiles from those mirrors, includes configured npm/PyPI targets as
root package specs, resolves npm registry packages and Python wheels, writes portable
Git source metadata,
clones or updates Git dependency mirrors, scans package manifests and lockfiles from
those mirrors, and repeats until no new npm or Git inputs are found. It also writes
`workspace-snapshot.json` with the configured targets and their bundle-local mirror
paths for later verification.

For every selected `python-app` target, `download` creates a missing active plan or
replans one made stale by target, coverage-policy, or workspace-local recipe changes.
An existing current plan is reused, so download does not silently refresh application
versions. Use `plan --update` to force that refresh. `download --dry-run` never writes a
plan and asks for a normal download or an explicit `plan` when planning is required.
Wheels are stored once by content hash even when multiple applications reference them.
Platform locks, consumer configuration, runtime prerequisites, and plan diffs remain
application-specific.

Use `--target <index>` in workspace mode to download only selected targets from
`airgap-sync target list`. The option is repeatable. Partial downloads still reuse and
extend the same bundle, but pruning is skipped even when `--prune` or a prune default
is enabled, because other targets may still depend on existing bundle objects.

With an explicit root argument, keeps the lower-level behavior and scans that directory
directly.

Python resolution is strict and lock-first by default. `uv.lock` and `pylock.toml` are
consumed exactly; a `requirements*.txt` beside a lock from the same project is treated
as covered and is not resolved a second time. An uncovered requirements file or direct
PyPI target is reported as an error before its dependency closure is guessed.

The effective mode is selected in this order:

1. `download --allow-approximate-python` overrides the whole run.
2. A Git, PyPI, or exact root-wheel target's `pythonResolutionMode` overrides that
   target.
3. The top-level `pythonResolutionMode` in `airgap-sync.json` is the workspace default.

Use `approximate` only when the simplified highest-compatible/no-backtracking resolver
is an accepted tradeoff. The resulting fetch report remains marked
`approximate: true`.

`target add python-wheel` handles an exact root wheel that is not listed by the source
index, such as a vLLM CPU release asset. SHA-256 is mandatory. During download the wheel
is streamed into the bundle, hashed, and its embedded `METADATA` is validated against
the filename. That exact root is overlaid on the configured Python index; its
`Requires-Dist` edges are then resolved and the realized package/file/hash closure is
written to `python-seed-manifest.json`. Because dependency selection still uses the
no-backtracking resolver, this target requires the same explicit approximate opt-in.
Set it on the wheel target when other targets should remain lock-only.

`target add python-runtime` transfers a python-build-standalone archive into
`python-runtime-mirror/<build>/<archive>` and writes a checksum manifest. Point
llama-manager's `pythonMirrorUrl` at that bundle directory and select mirror
provisioning. The source URL must contain `/releases/download/` because uv's `--mirror`
contract preserves the path after that segment.

`--latest-policy bundled` is the default. It does not store computed `latest` entries
in `dist-tags.json`; publish derives them from the newest version already included in
the bundle for each package name. `--latest-policy source` also resolves and downloads
the source registry's `latest` for each included package name and records those tag
requirements in `dist-tags.json`.

`--tag-resolution-policy reuse-stable` is the default. It reuses a previous
`dist-tags.json` tag mapping only when the same `name + tag + requiredBy` existed in the
previous bundle and the mapped package tarball is still present. Root tag targets are
always resolved from the source registry. `--tag-resolution-policy refresh` resolves
all tag dependencies from the source registry.

`--range-resolution-policy reuse-stable` is also the default. It reuses a previous
transitive semver range resolution only when the same `name + range + requiredBy`
existed in the previous bundle, the resolved tarball is still present, and the declaring
parent did not change. Root range targets are always resolved from the source registry.
Use `--range-resolution-policy refresh` when transitive ranges should move to the newest
currently satisfying versions on every download.

Use `reuse-stable` for one linear update stream where the bundle is the only source of
Verdaccio updates. If the same registry is updated through other paths or independently
generated bundles, prefer `refresh` policies; reused dependency tags are restored
strictly and can move shared registry tags backward.

`--concurrency` controls parallel npm resolve/download workers. The default is `8`.
Use a lower value such as `4` on slow removable media or unstable network links.

`--registry-timeout-ms` controls npm metadata request timeout. The default is 60000.
`--tarball-timeout-ms` controls tarball download timeout. The default is 180000.
`--retry-delays-ms` can override transient network retry delays, for example
`--retry-delays-ms 1000,5000,15000,60000`.

`--prune` removes stale local bundle objects after a successful fixed-point download.
It deletes npm tarballs, unreferenced content-addressed Python artifacts, obsolete
application plans, and Git mirrors not referenced by the new indexes. It is skipped
when the download is incomplete and partial target downloads never prune shared
objects. This only cleans the transfer bundle; it does not delete packages from
Verdaccio or repositories from Gitea.

When a package manifest is in the same directory as a supported lockfile, `download`
uses the lockfile as the stronger source and does not also resolve that manifest's
range dependencies. Packages pulled only from lockfiles also do not expand their own
registry metadata dependencies; their transitive closure is expected to come from the
same lockfile. This keeps lockfile-based installs from accumulating newer transitive
versions that the install will not use.

After a successful non-dry-run download, the latest root reports are copied into
`airgap-bundle/runs/download/<run-id>/`. That run directory also includes
`resolution-changes.json`, a compact summary of npm mappings that were added, changed,
or pruned during the update.

The online bundle should store Git source identities and local mirrors, not
Gitea-specific target URLs.

## bundle prune

```bash
airgap-sync bundle prune ./airgap-bundle --dry-run
airgap-sync bundle prune ./airgap-bundle
```

Removes stale objects from the local transfer bundle: unreferenced `packages/*.tgz`,
`python-packages/*.whl`, and `git-mirrors/**/*.git`. The command refuses to run unless
the latest `collect-report.json` records a successful non-dry-run fixed-point download.
Dry runs write `prune-dry-run-report.json`; real runs write `prune-report.json`.

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
--range-resolution-policy <policy>
                          Range dependency policy: reuse-stable or refresh
--concurrency <number>    Concurrent registry and download operations
--registry-timeout-ms <ms>
                          Timeout for npm registry metadata requests
--tarball-timeout-ms <ms>
                          Timeout for npm tarball downloads
--retry-delays-ms <list>  Comma-separated retry delays for transient network errors
--dry-run                 Resolve and report without downloading
```

At least one package spec or `--manifest` is required.

`--dry-run` performs the same dependency traversal as a normal fetch, including
transitive dependencies and publish-time `latest` targets required by the selected
latest policy, but reads package manifests from registry metadata without downloading
tarballs.

`--concurrency` controls parallel npm resolve/download workers. The default is `8`.

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
  --python-owner pypi \
  --ignore-scripts
```

Checks the bundle without running package-manager installs. It validates bundle
manifests, tarballs, Python wheel identities/hashes and environment coverage, verifies
`workspace-snapshot.json`, checks Git mirror presence from `git-sources.json`, and
checks `apply-report.json` when present. The command writes `verify-report.json`.

Errors produce a non-zero exit code. Warnings, such as a missing `apply-report.json`
before the offline import has run, are reported but do not fail the command.

`verify install` runs real package-manager installs for Git targets recorded in
`workspace-snapshot.json`. It checks out each target project from the bundle-local Git
mirror into a temporary directory, detects the package manager from the lockfile, sets
the npm registry, and uses a temporary Git config with source-host rewrites to the
provided Gitea URL. It writes `verify-install-report.json`.
For a schema-v2 Python application, verification chooses the matching local platform
branch and compatible CPython minor, creates a temporary venv, fetches the published
hash-complete lock from Gitea, installs from the closed PyPI index with wheels-only,
no-dependency, and require-hashes controls, then runs `pip check` and reviewed recipe
health checks. If no compatible interpreter is available, it records a clear skip.
This is temporary verification; production Python provisioning and installation
remain external to `airgap-sync`.

When the detected package manager is pnpm, `verify install` sets `trustLockfile: true`
for that verification process. This avoids false failures from pnpm v11's default
`minimumReleaseAge` policy after packages have just been re-published into the local
registry.

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
created as bare repositories and fetched through explicit branch/tag refspecs.
Existing mirrors run `git remote set-url origin` and `git fetch --prune origin` for
`refs/heads/*` and `refs/tags/*`. Provider-specific refs such as GitHub pull-request
refs are intentionally not downloaded into new mirrors. The command writes
`git-fetch-report.json`. During fetch, each mirror is logged with its
repository, status, whether refs changed, and, when it can be counted locally, the
number of new commits on updated refs.

This is the online-side download step only. It does not push to Gitea; that belongs
to a later offline publish command.

## git apply

```bash
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local --dry-run
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local --mirrors-dir ./git-mirrors
airgap-sync git apply ./airgap-bundle --gitea http://gitea.local --token "$GITEA_TOKEN"
airgap-sync git apply ./airgap-bundle --gitea http://git.local --username git --password "$TOKEN"
```

Reads `git-sources.json` and pushes local bare mirrors to the closed-network Git host
by pruning and
force-updating only branches and tags: `refs/heads/*` and `refs/tags/*`.
Provider-specific refs such as GitHub pull-request refs are intentionally not pushed.
Target URLs preserve upstream owner/repository paths: for example
`https://github.com/antvis/G2.git` maps to `http://gitea.local/antvis/G2.git`.
The target repositories must already exist unless the Gitea instance is configured to
create repositories on push.

When `--token`, `GITEA_TOKEN`, or a saved token is available, the command uses it for
Git HTTP push authentication instead of relying on an interactive credential helper.
For non-Gitea HTTP Git hosts, pass `--username` and `--password` instead; no Gitea API
call is made in that mode.

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
airgap-sync publish
```

Publishes the whole bundle in the closed network: publish npm packages to an
npm-compatible registry, restore dist-tags, map Git sources to target Git URLs, create
missing Gitea owners/repositories when provisioning is enabled, push mirrors, and write
import reports. If `python-seed-manifest.json` exists, it also streams bundled wheels
to Gitea's PyPI endpoint without requiring Python, pip, or twine. Schema-v2 application
plans additionally publish environment plans, per-platform locks, prerequisite
reports, consumer configuration, and optional runtime/tool transfer artifacts to
Gitea Generic Packages. Existing immutable generic objects are skipped only after
their downloaded content matches the local SHA-256.

When run from an initialized workspace, `publish` defaults to `airgap-sync.json`:
`output` is used as the bundle path, `targetRegistry` as `--registry`, `giteaUrl` as
`--gitea`, `python.publishOwner` as `--python-owner`, the `gitOwnerStrategy` settings
described below, and `defaults.publish` for public repositories and global Git rewrites.
Passing `<bundle>`, `--registry`, `--gitea`, `--public`, or
`--configure-git-global` overrides those defaults.

Supported options:

```text
-r, --registry <url>      Target npm registry URL, defaults to targetRegistry
--gitea <url>             Closed-network Git host base URL, defaults to giteaUrl
--gitea-token <token>     Gitea API token, defaults to GITEA_TOKEN or saved secrets
--python-owner <owner>    Public Gitea owner for the anonymous Python index
--git-username <name>     Git HTTP username for non-Gitea push authentication
--git-password <token>    Git HTTP password/token for non-Gitea push authentication
--git-owner-strategy <strategy> preserve, authenticated-user, or fixed-owner
--git-publish-owner <owner> Destination owner for fixed-owner mapping
--git-publish-owner-kind <kind> user or organization for fixed-owner mapping
--mirrors-dir <dir>       Directory containing bare Git mirrors
--public                  Create public Gitea repositories instead of private repositories
--skip-git-provision      Assume target Git repositories already exist and skip Gitea API provisioning
--no-skip-existing        Attempt to publish npm versions that already exist
--dist-tag-concurrency <n> Concurrent npm dist-tag operations, default 4
--publish-concurrency <n> Concurrent npm publish operations, default 4
--configure-git-global    Write Git URL rewrite rules into global Git config
--dry-run                 Print planned publish operations without publishing or pushing
```

Prefer the `GITEA_TOKEN` environment variable or a saved token over `--gitea-token` so
the token does not appear in shell history or process listings.

The Gitea token is used for API repository provisioning, Git HTTP mirror push
authentication, and Python wheel upload. Consumer pip configuration contains no token.

Use `--skip-git-provision` when the closed-network Git repositories are created outside
`airgap-sync`, or when the target Git host is not Gitea-compatible. In that mode
`publish` does not call the Gitea API; it only pushes Git mirrors to URLs derived from
`--gitea`. If the Git host needs HTTP credentials, provide `--git-username` and
`--git-password`.

Git target paths preserve source owner/repository names by default. For example,
`https://github.com/antvis/G2.git` maps to `http://gitea.local/antvis/G2.git`, so
consumer machines can use one broad `insteadOf` rule for the source host. `publish`
writes those rewrite rules into `git-apply-report.json`; it only mutates global Git
config when `--configure-git-global` is passed.

Owner mapping is explicit so an upstream owner that already exists as a Gitea user does
not get treated as an organization by accident:

- `preserve` (default) mirrors `<upstream-owner>/<repo>` and provisions missing owners
  as organizations;
- `authenticated-user` publishes under the token's user as
  `<user>/<upstream-owner>--<repo>` and never provisions an organization;
- `fixed-owner` publishes under `gitPublishOwner` with the declared
  `gitPublishOwnerKind`. A fixed user must match the token's authenticated user.

Remapped repositories use repository-specific Git rewrite rules. The source identity and
bundle mirror path remain unchanged. Equivalent workspace configuration is:

```json
{
  "gitOwnerStrategy": "fixed-owner",
  "gitPublishOwner": "mirrors",
  "gitPublishOwnerKind": "organization"
}
```

After a non-dry-run publish, the generated publish/apply reports are copied into
`airgap-bundle/runs/publish/<run-id>/` so the previous offline import diagnostics are
not lost on the next run.
