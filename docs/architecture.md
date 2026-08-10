# Architecture

`airgap-sync` builds a transfer bundle that can populate Verdaccio and Gitea package
registries through normal publication APIs.

The product direction is broader: a portable airgap dependency sync tool for projects
that combine Git repositories, npm registry dependencies, npm Git dependencies,
Python applications, and explicitly selected portable CPython distributions. The
npm/Verdaccio bundle, Python application planner, CPython distribution provider, Git
mirror transfer, npm/Git fixed-point collection, and top-level publish orchestration
are the main architectural layers.

## Problem

Offline installs fail when the target registry lacks either:

- package versions required by dependency resolution;
- `dist-tags` such as `latest`, `beta`, or custom tags used as dependency specs.
- Git repositories referenced directly from package specs.

Tarballs alone are not enough because npm registry metadata is part of dependency
resolution. Registry population alone is not enough because npm package graphs can
contain Git dependencies such as `github:owner/repo#sha` or `git+https://...#sha`.

## Non-Goals

- Mirroring the entire public npm registry.
- Rewriting or updating project lockfiles.
- Acting as a live proxy registry.
- Installing or managing production Python runtimes, system packages, drivers, or
  environments.
- Inferring target coverage from the collector or maintaining detailed host inventory.
- Transferring model weights as if they were Python package dependencies.
- Supporting non-PyPI consumer ecosystems such as conda, apt, or container images in
  the normal Python package path.
- Mutating Verdaccio storage files directly.
- Replacing Git with npm registry packages by repacking third-party tarballs by default.

## Data Flow

```text
workspace targets / package specs / package.json / package list
  -> fetch configured Git targets as bundle-local mirrors
  -> scan package manifests from Git mirrors
  -> resolve specs through source registry metadata
  -> download tarballs
  -> inspect package manifests from tarballs
  -> fetch Git dependencies as bundle-local mirrors
  -> recurse dependencies
  -> resolve each Python application tree to its leaves for every compatibility cell
  -> minimize the wheels-only union that covers the declared envelope
  -> validate normal package resolution against a bundle-only Python index
  -> select portable CPython distributions independently from application packages
  -> write airgap bundle

airgap bundle
  -> npm publish tarballs
  -> npm dist-tag add required tags
  -> create Gitea owners/repositories when using the Gitea provider
  -> push Git mirrors
  -> publish Python wheels to Gitea PyPI
  -> publish optional Python evidence and reports to Gitea Generic Packages
  -> publish CPython distributions additively to Gitea Generic Packages
```

## Target Airgap Flow

```text
online removable media
  -> fetch configured Git targets as bundle-local mirrors
  -> scan package manifests and lockfiles from Git mirrors
  -> resolve npm registry package closure
  -> resolve Git dependency closure
  -> download npm tarballs
  -> mirror Git repositories
  -> plan Python repository coverage independently of collector OS/architecture
  -> collect each selected Python dependency tree down to its leaves
  -> download the content-addressed minimum wheel union
  -> select and download the rolling portable CPython distribution set
  -> scan manifests from newly mirrored Git dependencies
  -> repeat npm/Git collection until no new inputs are found
  -> write transfer bundle

closed network
  -> publish npm tarballs into an npm-compatible registry
  -> restore npm dist-tags
  -> map Git sources to closed-network Git targets
  -> create missing Gitea owners/repositories when enabled
  -> push Git mirrors into the closed-network Git host
  -> publish Python wheels and standard metadata to Gitea PyPI
  -> publish portable CPython distributions to Gitea Generic Packages
  -> verify install against closed-network services

consumer infrastructure
  -> provide a compatible CPython and system prerequisites
  -> configure only the Gitea PyPI index
  -> install normally with pip, uv, Poetry, PDM, or another compatible client
```

The Git side should use standard Git primitives where possible:

- bare local mirrors fetched through explicit branch/tag refspecs;
- branch/tag refspec pushes into Gitea;
- `git bundle` for auditable file-based transfer when a Git server is not available.

The npm side should continue to populate npm-compatible registries through
`npm publish` and `npm dist-tag`, not by mutating registry storage.

## Repository Input Policy

The primary transfer workflow starts from Git target URLs in `airgap-sync.json`.
Configured targets and Git dependencies use the same storage model: local bare mirrors
under `airgap-bundle/git-mirrors/`, preserving source host and owner/repository paths.

Lower-level collection from an explicit directory is still available for diagnostics
and one-off use. If that directory contains Git repositories, its update policy is
conservative:

- find repositories by locating `.git` directories or files;
- skip nested repositories once the nearest parent repository is selected;
- refuse to update dirty worktrees unless explicitly overridden;
- run `git pull --ff-only` for normal branches;
- record detached HEADs, merge conflicts, authentication failures, and non-fast-forward
  branches in a report instead of trying to repair them.

Workspace-mode collection does not keep separate working clones. The bundle is the
portable Git store.

## Resolver Policy

The resolver should use npm-compatible rules:

- `version`: fetch that exact version.
- `range`: choose the highest version satisfying the range from source metadata.
- `tag`: resolve the tag through source `dist-tags`.
- `alias`: resolve the underlying package spec.
- `file`, `link`, `workspace`, `git`, and remote tarball specs are reported and skipped
  unless explicitly supported later.

Unsupported specs must retain their `requiredBy` package so operators can decide
whether they are root project concerns, transitive registry package concerns, or Git
dependency closure work.

By default, recursive traversal should include:

- `dependencies`
- `optionalDependencies`

Project package-manager declarations are a separate input class rather than ordinary
application dependencies. A pnpm declaration contributes both `pnpm` and `@pnpm/exe`
bootstrap roots and must be read even when a lockfile covers the adjacent manifest.
For ranged `devEngines.packageManager`, exact `packageManagerDependencies` recorded by
pnpm-lock take precedence.

`peerDependencies` are not installed automatically by all historical npm clients, but
modern npm and pnpm may auto-install peers depending on settings. Peer handling should
therefore be an explicit option before the first stable release.

## Input Modes

The primary operator workflow is workspace-based:

```bash
airgap-sync target add git https://github.com/acme/app.git --branch main
airgap-sync target add npm eslint@latest
airgap-sync download
```

Direct package specs are also supported:

```bash
airgap-sync fetch react@latest @types/node@^22
```

This lets an operator seed a registry with one or more packages and their transitive
dependencies without creating a temporary project.

Manifest input is available for lower-level package collection:

```bash
airgap-sync fetch --manifest ./package.json
```

Both modes should produce the same internal root requirements:

```text
package name + npm specifier + requiredBy=root
```

For manifest input, `--manifest` accepts either a package.json file or a directory. The
scan root is the manifest's containing directory or the directory itself, and nested
package.json files are included so monorepositories can be seeded from the root.
`node_modules` and common generated directories are skipped. Dependencies whose names
match local packages discovered in the same scan root are skipped for local
`workspace:`, `file:`, and `link:` specs.

Dry-run fetch uses the same traversal policy as a normal fetch, but reads dependency
metadata from the source registry without downloading tarballs.

## Python Application Policy

The normal Python input is a `python-app` target: application intent plus an effective
bounded compatibility envelope. Platform coverage and Python versions normally come
from workspace `python.applicationDefaults`; target-local fields are independent
overrides for exceptional applications. The initial maximum envelope is CPython 3.10–3.13 on Windows
x86-64 and glibc Linux x86-64. A platform family describes artifact compatibility, not
a distribution name or host record, so collection stays independent from the online
machine.

Gitea PyPI is the consumer interface. A consumer configures its Simple API URL and
installs normally with a standards-compatible client. It must not need an
`airgap-sync` plan, lock, resolver version, or Generic Package in order to discover and
install Python dependencies.

Planning has two responsibilities:

1. use a reviewed resolver and source-index metadata to choose one complete recursive
   dependency tree for every application/environment cell;
2. prove that ordinary clients can install from an index populated only with the
   resulting bundle artifacts.

There is no requirement for consumers to select the same versions as the collector.
The bundle must merely contribute at least one complete installable tree. Packages
already present in Gitea, later additive publications, and other independent
`airgap-sync` workspaces are outside planning and need not be inventoried.

Collection is wheels-only. Rather than retaining every compatible build, the planner
selects the smallest content-addressed wheel union that covers all declared cells.
Universal and `abi3` wheels are shared where possible. Missing wheels are explicit
coverage failures; source builds are never an implicit fallback.

Workspace-local recipes may capture reviewed index choices, required extras, explicit
artifact-changing features, and known incompatibilities. They remain optional policy
adapters rather than per-application installers. CPU, CUDA, and ROCm are relevant only
when they change Python artifact selection; drivers and other system prerequisites are
outside the bundle.

Locks and resolver evidence may be retained for audit or an explicitly frozen install,
but are not the normal consumer contract. A pinned collector `uv` is likewise an
internal implementation detail rather than a consumer compatibility dimension.

Target ownership follows the npm model. Active targets and their `requiredBy` edges
keep local bundle objects alive. Removing a one-time target allows locally unreferenced
objects to be pruned, but never removes packages already published to Gitea.

Portable CPython transfer is a separate `cpython-distributions` target and is never
implied by adding an application target. It uses a rolling local bundle and additive
Gitea Generic Package publication. Package-manager binaries are separate ordinary
Python applications. `airgap-sync` transfers these artifacts but does not install or
manage production environments.

The normative contracts and supported envelopes are defined in
[Python Support](python.md),
[ADR 0010](decisions/0010-gitea-pypi-as-python-consumer-interface.md), and
[ADR 0011](decisions/0011-cpython-distribution-transfer.md).

## Collection Fixed Point

The high-level `download` command should not run npm collection only once. Git
dependencies may themselves contain package manifests, and those manifests can introduce
new npm dependencies or more Git dependencies.

Collection should therefore run to a fixed point:

```text
scan project package.json files
  -> resolve and download npm registry packages
  -> discover Git specs in package manifests
  -> clone/update missing Git dependency mirrors
  -> scan package.json files from newly mirrored Git repositories
  -> repeat until no new npm requirements and no new Git repositories appear
```

If a new Git repository is cloned or updated in a way that exposes new manifests, the
npm resolver must run again before the bundle is considered complete.

## Tag Policy

Tags that are required by discovered dependency specs should be restored. This matters
for real dependency specs such as `node-fetch@cjs`, where the package manager asks the
registry for a tag instead of a concrete version.

The default `tagResolutionPolicy` is `reuse-stable`. During repeated downloads, a tag
dependency can reuse the previous bundle's tag resolution only when all of these are
true:

- the previous `dist-tags.json` contains the same `name + tag + requiredBy` mapping;
- the mapped package version is still present in `seed-manifest.json`;
- the mapped tarball still exists on disk;
- the declaring parent is stable.

For npm registry parents, stable means the declaring `package@version` is already in
the previous bundle. For Git/project parents, stable means the source mirror fetch did
not change refs in this run. If a Git mirror was cloned or fetched new refs, tag
dependencies from its package.json files are resolved from the source registry.

Root tag targets such as `eslint@latest` are always explicit operator requests and are
resolved from the source registry. `tagResolutionPolicy: "refresh"` disables reuse and
resolves all tag dependencies from source metadata.

The default `rangeResolutionPolicy` is also `reuse-stable`. During repeated downloads,
a transitive semver range first tries to reuse the previous bundle's exact
`name + range + requiredBy` mapping when all of these are true:

- the previous `seed-manifest.json` contains the same `name + range + requiredBy`
  reason;
- the resolved package version is still present in `seed-manifest.json`;
- the mapped tarball still exists on disk;
- the declaring parent is stable.

If that exact mapping is absent but the declaring parent is stable, the resolver falls
back to the highest already bundled version that satisfies the range. Only when no
bundled version satisfies the range does it resolve the transitive range from the source
registry.

Root range targets are explicit operator requests and are always resolved from the
source registry. `rangeResolutionPolicy: "refresh"` disables range reuse and lets
transitive ranges float to the newest currently satisfying versions.

The npm security policy adds a second, narrower decision layer. With the default
`vulnerabilityResolutionPolicy: "prefer-clean"`, the initially selected unlocked graph
is queried through OSV before tarball download. For each vulnerable SemVer-range
selection, up to 20 compatible versions that pass the release-age rule are checked in
descending order. A finding-free version becomes an exact override for that parent and
range, and the graph is resolved again; the bounded fixed point uses at most four
analysis passes. Exact, tag, alias, and lockfile requirements are not rewritten.
`report-only` bypasses this layer. Once analysis reaches its final graph, tarballs are
materialized directly from that graph without an additional resolution pass.

`reuse-stable` assumes a single linear update stream where the bundle is the
authoritative source for registry tag state. npm dist-tags are global per package name,
not per declaring parent. If Verdaccio is also updated by other tools, by manually
published packages, or by multiple removable drives carrying independently generated
bundles, a reused old dependency tag can move a shared registry tag backward. In those
environments use `tagResolutionPolicy: "refresh"` and apply bundles in generation order,
or keep separate registries for independent update streams.

`latest` is a special case. Verdaccio may create or keep `latest` during `npm publish`
even when publishing with a custom temporary tag, and deleting the last `latest` tag is
not reliable enough to use as a safety mechanism. The publish step must therefore make
an explicit `latest` decision for every package name that may be newly published.

The default `latestPolicy` is `bundled`. In this mode, the tool does not fetch the
source registry's `latest` for every transitive package. Instead, publish computes
`latest` from `seed-manifest.json`: for each package name, it uses the newest version
already present in the bundle unless a real `latest` tag requirement exists in
`dist-tags.json`. This keeps regular update bundles smaller, avoids pulling fresh
upstream versions for deep transitive packages that were not otherwise needed, and
keeps `dist-tags.json` focused on real tag requirements.

`bundled` latest requirements are publish-time safety defaults, not strict tag
restorations. During publish, they must not move an existing target registry `latest`
backward to an older version from the bundle. If Verdaccio already has a semantically
newer `latest`, the bundled latest operation is skipped.

The optional `latestPolicy: "source"` mode preserves the older, more aggressive
behavior. When any package name is included in a bundle, the fetch step also includes
the source registry's `latest` target for that package name and traverses its
dependencies. Use this mode when the operator wants a fresher local registry and accepts
larger bundles. In this mode, the source registry's `latest` tag requirements are
stored in `dist-tags.json`.

Explicit root tag requirements still resolve through the source registry. Dependency
tag requirements such as `node-fetch@cjs` follow `tagResolutionPolicy` and are restored
strictly during publish. The latest policy only controls the artificial publish-time
`latest` tag added for package names that are already in the bundle.

## Publish Policy

Publishing should use standard commands:

```bash
npm publish ./packages/foo-1.0.0.tgz --registry http://verdaccio:4873 --tag airgap-sync-temp
npm dist-tag add foo@1.0.0 latest --registry http://verdaccio:4873
```

Temporary publish tags avoid accidental `latest` assignment while all versions are being
published. Before publishing a package name that is absent from the target registry, the
publish step verifies that the bundle contains a `latest` tag requirement for that name.

## Git Dependency Policy

Git dependencies are not registry packages. If a package manifest contains:

```text
github:owner/repo#commit
git+https://github.com/owner/repo.git#commit
```

the package manager may attempt to access GitHub during install. Publishing npm
tarballs into Verdaccio does not make those Git URLs resolvable.

The preferred strategy is to mirror the referenced Git repository into the closed
network and make the original spec resolve to that mirror.

Online collection should store source Git identities, not target Git-host-specific URLs.
The bundle should be portable between closed networks. A source record should include:

- canonical source URL;
- source host;
- owner/repository path;
- requested commitish/range/subdirectory;
- local mirror path inside the bundle;
- `requiredBy` edges that explain why the repository was included.

Offline publish maps those source identities to the target Git host. The first
implemented provisioning provider is Gitea; generic Git hosts can be used when target
repositories are created outside `airgap-sync`.

## Git Mirror Naming Policy

Git mirror paths should preserve upstream owner/repository identity whenever possible.
For GitHub-style sources:

```text
https://github.com/antvis/G2.git -> http://gitea.local/antvis/G2.git
```

This keeps consumer configuration simple:

```bash
git config --global url."http://gitea.local/".insteadOf "https://github.com/"
```

The closed-network publish phase can create missing Gitea owners or repositories, or it
can skip provisioning and assume target repositories already exist. Owner handling is
an explicit policy: preserve upstream owners as organizations, publish beneath the
authenticated user, or publish beneath one configured user/organization. Namespaced
strategies use `<upstream-owner>--<repo>` and repository-specific rewrites while keeping
the immutable source identity and local mirror path separate from the publish target.

Possible mechanisms for making installs resolve to local mirrors:

- generate broad `git config url.<gitea-url>.insteadOf <public-host-url>` rules when
  owner/repository paths are preserved;
- generate repository-specific rewrite rules only as a fallback;
- rewrite root project specs when the operator owns the repository;
- as a last resort, patch/repack third-party tarballs only with explicit operator
  approval because that changes package contents and may invalidate lockfile integrity.
