# Roadmap

## Milestone 1: Repository Skeleton

- TypeScript CLI scaffold.
- Documentation for architecture, CLI, and bundle format.
- Formatting, linting, type-checking, tests, and CI.

## Milestone 2: Resolver MVP

- Resolve one or more package specs from CLI arguments.
- Resolve `version`, `range`, `tag`, and `alias` specs.
- Download tarballs into `packages/`.
- Traverse `dependencies` and `optionalDependencies`.
- Write `seed-manifest.json` and `dist-tags.json`.

## Milestone 2.1: Manifest Input

- Read one root `package.json`.
- Include production dependencies by default.
- Optionally include root `devDependencies`.

## Milestone 3: Publish MVP

- Publish all tarballs to Verdaccio.
- Use a temporary publish tag.
- Restore tags from `dist-tags.json`.
- Write `publish-report.json`.

## Milestone 4: Project-Scale Inputs

- Accept multiple manifests.
- Accept package spec lists.
- Support workspace roots.
- Add `info` and `verify` commands.

## Milestone 5: Hardening

- Retry and backoff.
- Auth token discovery.
- Deterministic reports.
- Integration tests with Verdaccio.
