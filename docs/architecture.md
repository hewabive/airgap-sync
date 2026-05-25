# Architecture

`airgap-sync` currently builds a transfer bundle that can populate Verdaccio
through normal npm publishing commands.

The product direction is broader: a portable airgap dependency sync tool for projects
that combine Git repositories, npm registry dependencies, and npm Git dependencies.
The npm/Verdaccio bundle, Git mirror transfer, fixed-point collection, and top-level
publish orchestration are the main architectural layers.

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
  -> write airgap bundle

airgap bundle
  -> npm publish tarballs
  -> npm dist-tag add required tags
  -> create Gitea owners/repositories
  -> push Git mirrors
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
  -> scan manifests from newly mirrored Git dependencies
  -> repeat npm/Git collection until no new inputs are found
  -> write transfer bundle

closed network
  -> publish npm tarballs into Verdaccio
  -> restore npm dist-tags
  -> map Git sources to Gitea targets
  -> create missing Gitea owners/repositories
  -> push Git mirrors into Gitea
  -> generate install configuration
  -> verify install against closed-network services
```

The Git side should use standard Git primitives where possible:

- bare local mirrors fetched through explicit branch/tag refspecs;
- branch/tag refspec pushes into Gitea;
- `git bundle` for auditable file-based transfer when a Git server is not available.

The npm side should continue to populate Verdaccio through `npm publish` and
`npm dist-tag`, not by mutating Verdaccio storage.

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
a transitive semver range can reuse the previous bundle's resolved version when all of
these are true:

- the previous `seed-manifest.json` contains the same `name + range + requiredBy`
  reason;
- the resolved package version is still present in `seed-manifest.json`;
- the mapped tarball still exists on disk;
- the declaring parent is stable.

Root range targets are explicit operator requests and are always resolved from the
source registry. `rangeResolutionPolicy: "refresh"` disables range reuse and lets
transitive ranges float to the newest currently satisfying versions.

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

Online collection should store source Git identities, not Gitea-specific target URLs.
The bundle should be portable between closed networks. A source record should include:

- canonical source URL;
- source host;
- owner/repository path;
- requested commitish/range/subdirectory;
- local mirror path inside the bundle;
- `requiredBy` edges that explain why the repository was included.

Offline publish maps those source identities to the target Gitea instance.

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

The closed-network publish phase is responsible for creating missing Gitea owners or
repositories. Flattened names such as `github.com-antvis-g2` should be treated as a
temporary implementation detail or fallback for hosts that cannot be mapped cleanly to
an owner/repository path.

Possible mechanisms for making installs resolve to local mirrors:

- generate broad `git config url.<gitea-url>.insteadOf <public-host-url>` rules when
  owner/repository paths are preserved;
- generate repository-specific rewrite rules only as a fallback;
- rewrite root project specs when the operator owns the repository;
- as a last resort, patch/repack third-party tarballs only with explicit operator
  approval because that changes package contents and may invalidate lockfile integrity.
