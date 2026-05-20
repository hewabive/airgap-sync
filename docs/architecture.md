# Architecture

`npm-registry-seed` currently builds a transfer bundle that can populate Verdaccio
through normal npm publishing commands.

The product direction is broader: a portable airgap dependency sync tool for projects
that combine Git repositories, npm registry dependencies, and npm Git dependencies.
The npm/Verdaccio bundle is the first implemented subsystem.

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
package specs / package.json / package list
  -> resolve specs through source registry metadata
  -> download tarballs
  -> inspect package manifests from tarballs
  -> recurse dependencies
  -> write seed bundle

seed bundle
  -> npm publish tarballs
  -> npm dist-tag add required tags
```

## Target Airgap Flow

```text
online removable media
  -> refresh Git repositories
  -> scan package manifests and lockfiles
  -> resolve npm registry package closure
  -> resolve Git dependency closure
  -> download npm tarballs
  -> mirror Git repositories or create Git bundles
  -> write transfer bundle

closed network
  -> push Git mirrors into Gitea
  -> publish npm tarballs into Verdaccio
  -> restore npm dist-tags
  -> generate install configuration
  -> verify install without external network access
```

The Git side should use standard Git primitives where possible:

- `git clone --mirror` / `git fetch --all` for local mirrors;
- `git push --mirror` or safer per-ref pushes into Gitea;
- `git bundle` for auditable file-based transfer when a Git server is not available.

The npm side should continue to populate Verdaccio through `npm publish` and
`npm dist-tag`, not by mutating Verdaccio storage.

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

The first implementation target is direct package specs:

```bash
npm-registry-seed fetch react@latest @types/node@^22
```

This is the smallest useful workflow: it lets an operator seed a registry with one or
more packages and their transitive dependencies without creating a temporary project.

Manifest input is the second target:

```bash
npm-registry-seed fetch --manifest ./package.json
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
npm publish ./packages/foo-1.0.0.tgz --registry http://verdaccio:4873 --tag npm-registry-seed-temp
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
network and make the original spec resolve to that mirror. Possible mechanisms:

- generate `git config url.<gitea-url>.insteadOf <public-url>` rules;
- rewrite root project specs when the operator owns the repository;
- as a last resort, patch/repack third-party tarballs only with explicit operator
  approval because that changes package contents and may invalidate lockfile integrity.
