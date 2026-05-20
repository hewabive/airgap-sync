# 0003: Include Latest for Published Packages

Date: 2026-05-20

## Status

Accepted

## Context

The original tag policy restored only tags that appeared in package specs. During
Verdaccio testing we found that `npm publish --tag <temporary>` can still leave `latest`
on a newly published package. Removing `latest` is not a reliable safety mechanism in
Verdaccio, because the registry can keep or recreate it.

In a shared registry, a wrong `latest` is worse than an extra package version: it can
change dependency resolution for unrelated projects.

## Decision

For every package name included in a bundle, also include the source registry's `latest`
target and record a `latest` tag requirement. If that version is not already in the
bundle, download it and traverse its dependencies.

During publish, refuse to publish a package name that does not already exist in the
target registry unless the bundle contains a `latest` tag requirement for that name.

## Consequences

- Fresh Verdaccio package names get `latest` aligned with the source registry.
- Bundles can be larger, because an exact or range dependency may pull in an additional
  latest version and its dependency closure.
- Old bundles created without this policy are rejected before they can corrupt a fresh
  target registry package name.
