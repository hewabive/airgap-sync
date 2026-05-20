# Architecture

`npm-registry-seed` builds a transfer bundle that can populate Verdaccio through
normal npm publishing commands.

## Problem

Offline installs fail when the target registry lacks either:

- package versions required by dependency resolution;
- `dist-tags` such as `latest`, `beta`, or custom tags used as dependency specs.

Tarballs alone are not enough because npm registry metadata is part of dependency
resolution.

## Non-Goals

- Mirroring the entire public npm registry.
- Rewriting or updating project lockfiles.
- Acting as a live proxy registry.
- Mutating Verdaccio storage files directly.

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

## Resolver Policy

The resolver should use npm-compatible rules:

- `version`: fetch that exact version.
- `range`: choose the highest version satisfying the range from source metadata.
- `tag`: resolve the tag through source `dist-tags`.
- `alias`: resolve the underlying package spec.
- `file`, `link`, `workspace`, `git`, and remote tarball specs are reported and skipped
  unless explicitly supported later.

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

## Tag Policy

For shared registries, tags must match the source registry targets at fetch time.

The tool must not assign `latest` to a lockfile version simply because that version was
downloaded. That would make one project's seed corrupt another project's dependency
resolution in the same Verdaccio instance.

Only tags that are required by discovered dependency specs should be restored.

## Publish Policy

Publishing should use standard commands:

```bash
npm publish ./packages/foo-1.0.0.tgz --registry http://verdaccio:4873 --tag npm-registry-seed-temp
npm dist-tag add foo@1.0.0 latest --registry http://verdaccio:4873
```

Temporary publish tags avoid accidental `latest` assignment while all versions are being
published.
