# 0004: Reuse Stable Tag Dependencies

Date: 2026-05-24

## Status

Accepted

## Context

Some npm packages declare dependencies through tags, for example `node-fetch@cjs`.
Following those tags on every repeated download can pull new transitive versions even
when the declaring parent package did not change.

For regular removable-media updates this is undesirable: it increases bundle size and
can make the closed-network registry drift because a deep dependency tag moved in the
public registry.

## Decision

Add `tagResolutionPolicy`:

- `reuse-stable` is the default. It reuses the previous bundle's tag resolution when
  the same `name + tag + requiredBy` mapping exists in `dist-tags.json`, the mapped
  package exists in `seed-manifest.json`, the mapped tarball is still present, and the
  declaring parent is stable.
- `refresh` always resolves tag dependencies from source registry metadata.

For npm registry parents, stable means the declaring `package@version` was already in
the previous bundle. For Git/project parents, stable means the Git mirror fetch did not
change refs in the current run.

Root tag targets, such as an operator adding `eslint@latest`, remain explicit refresh
requests and always resolve through the source registry.

`reuse-stable` is intended for a single linear update stream where the generated bundle
is the only source of changes to the closed-network npm registry. npm dist-tags are
global per package name; they cannot represent different versions for different
declaring parents. If the same Verdaccio instance is updated by other tools or by
independently generated bundles, use `refresh` and apply bundles in generation order.

## Consequences

- Repeated downloads avoid following moved transitive tags when parent packages did not
  change.
- A previous tag mapping is reused only when it is tied to the same declaring parent;
  an unrelated package version in the bundle is not enough.
- Reused dependency tags are restored strictly during publish, so `reuse-stable` is not
  suitable for registries that receive independent updates from multiple sources.
- Git mirror fetch reports must distinguish "remote update command ran" from "refs
  changed" so Git/project manifests can participate in the policy.
