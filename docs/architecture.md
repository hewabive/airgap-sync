# Architecture

`airgap-sync` currently builds a transfer bundle that can populate Verdaccio
through normal npm publishing commands.

The product direction is broader: a portable airgap dependency sync tool for projects
that combine Git repositories, npm registry dependencies, and npm Git dependencies.
The npm/Verdaccio bundle, Git mirror transfer, fixed-point collection, and top-level
apply orchestration are the main architectural layers.

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
  -> verify install without external network access
```

The Git side should use standard Git primitives where possible:

- `git clone --mirror` / `git fetch --all` for local mirrors;
- `git push --mirror` or safer per-ref pushes into Gitea;
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
airgap-sync collect
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
metadata from the source registry instead of downloading tarballs and extracting
package.json files.

## Collection Fixed Point

The high-level `collect` command should not run npm collection only once. Git
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

For shared registries, tags must match the source registry targets at fetch time.

The tool must not assign `latest` to a lockfile version simply because that version was
downloaded. That would make one project's seed corrupt another project's dependency
resolution in the same Verdaccio instance.

Tags that are required by discovered dependency specs should be restored.

`latest` is a special case. Verdaccio may create or keep `latest` during `npm publish`
even when publishing with a custom temporary tag, and deleting the last `latest` tag is
not reliable enough to use as a safety mechanism. Therefore, when any package name is
included in a bundle, the fetch step also includes the source registry's `latest` target
for that package name and records a `latest` tag requirement. If that pulls in an
additional version, its dependencies are traversed too.

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

Offline apply maps those source identities to the target Gitea instance.

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

The closed-network apply phase is responsible for creating missing Gitea owners or
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
