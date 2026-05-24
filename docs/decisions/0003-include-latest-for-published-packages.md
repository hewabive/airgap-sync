# 0003: Decide Latest for Published Packages

Date: 2026-05-20

## Status

Accepted, amended 2026-05-24

## Context

An earlier internal policy restored only tags that appeared in package specs. During
Verdaccio testing we found that `npm publish --tag <temporary>` can still leave `latest`
on a newly published package. Removing `latest` is not a reliable safety mechanism in
Verdaccio, because the registry can keep or recreate it.

In a shared registry, a wrong `latest` is worse than an extra package version: it can
change dependency resolution for unrelated projects.

## Original Decision

For every package name included in a bundle, also include the source registry's `latest`
target and record a `latest` tag requirement. If that version is not already in the
bundle, download it and traverse its dependencies.

During publish, refuse to publish a package name that does not already exist in the
target registry unless the bundle contains a `latest` tag requirement for that name.

## Amendment

Always require a `latest` tag decision for each package name that may be newly published,
but make the source of that decision configurable:

- `latestPolicy: "bundled"` is the default. It assigns `latest` to the newest version
  already present in the bundle for each package name.
- `latestPolicy: "source"` preserves the original decision. It also resolves and
  downloads the source registry's current `latest` target for every included package
  name and traverses its dependencies.

Bundled latest requirements are soft during publish: they must not downgrade an
existing target registry `latest` that already points to a newer semver version.

Real tag dependencies still resolve through the source registry regardless of this
setting. For example, `node-fetch@cjs` must restore `cjs` to the source registry's
version, and an explicit target such as `eslint@latest` resolves `latest` as a real
operator request.

## Consequences

- Fresh Verdaccio package names always get an explicit `latest` tag instead of relying
  on Verdaccio's publish-time behavior.
- Default bundles stay smaller because deep transitive packages do not automatically
  pull an additional upstream latest version and its dependency closure.
- Repeated imports can apply older bundles without moving an already newer Verdaccio
  `latest` backward.
- Operators can still choose source-aligned `latest` when storage and update breadth are
  more important than bundle size.
- Old bundles created without this policy are rejected before they can corrupt a fresh
  target registry package name.
