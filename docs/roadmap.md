# Roadmap

The current implementation started as a Verdaccio seed tool. The direction is now a
larger airgap sync workflow that coordinates Git repository transfer, npm registry
package transfer, Git dependencies found inside npm package graphs, and offline
verification.

## Milestone 1: Repository Skeleton

- Done: TypeScript CLI scaffold.
- Done: Documentation for architecture, CLI, and bundle format.
- Done: Formatting, linting, type-checking, tests, and CI.

## Milestone 2: Resolver

- Done: Resolve one or more package specs from CLI arguments.
- Done: Resolve `version`, `range`, `tag`, and `alias` specs.
- Done: Download tarballs into `packages/`.
- Done: Traverse `dependencies` and `optionalDependencies`.
- Done: Write `seed-manifest.json` and `dist-tags.json`.

## Milestone 2.1: Manifest Input

- Done: Read package.json files from files or directories.
- Done: Include production dependencies by default.
- Done: Optionally include root `devDependencies`.
- Done: Scan nested package.json files for monorepositories.
- Done: Read npm, pnpm, and Yarn lockfiles when present.

## Milestone 3: Publish

- Done: Publish all tarballs to Verdaccio.
- Done: Use a temporary publish tag.
- Done: Restore tags from `dist-tags.json`.
- Done: Write `publish-report.json`.
- Done: Add package existence pre-checks and concurrency.

## Milestone 4: Project-Scale Inputs

- Done: Accept multiple manifests.
- Done: Accept package spec lists.
- Done: Support workspace roots.
- Done: Add `info` and `verify` commands.

## Milestone 5: Hardening

- Todo: Retry and backoff for transient registry/Git failures.
- Todo: Auth token discovery for private source registries and private Git hosts.
- In progress: deterministic reports.
- Done: Integration tests with Verdaccio and Gitea.

## Milestone 6: Git Repository Orchestration

- Done: Fetch configured Git targets as bundle-local mirrors.
- Done: Scan manifests from target and dependency Git mirrors.
- Done: Add `collect` orchestration for npm bundle fetch, Git source metadata, and Git
  mirror fetch.
- Done: Mirror repositories for transfer into a closed network.
- Done: Push mirrors into Gitea.
- Done: Generate `insteadOf` rules for closed-network installs.
- Todo: Decide whether protected-ref handling needs safer defaults than `git push --mirror`.

## Milestone 7: Git Dependencies in Node Graphs

- Done: Preserve `requiredBy` for unsupported Git specs in fetch reports.
- Done: Parse npm Git specs into canonical repository URL and commit/tag selectors.
- Done: Store source Git identities in the online bundle without binding them to a
  specific Gitea instance.
- Done: Fetch local bare mirrors for Git dependencies discovered in transitive npm
  package manifests.
- Done: Re-run npm dependency collection when newly mirrored Git repositories expose
  additional package manifests.
- Done: Preserve upstream owner/repository paths when mapping mirrors into Gitea.
- Done: Create missing Gitea owners/repositories during the offline apply phase.
- Done: Push local bare mirrors to derived Gitea target URLs and emit broad `insteadOf`
  rules when preserved paths make that safe.
- Done: Configure Git `insteadOf` rewrite rules from the transfer bundle.
- Done: Recursively inspect package manifests from Git dependencies.
- Todo: Decide when URL rewriting is enough and when package/lockfile patching is
  required.

## Milestone 8: End-to-End Verification

- Done: Create temporary install directories with isolated package-manager caches.
- Done: Force npm registry access through Verdaccio.
- Done: Force Git access through Gitea rewrite rules.
- Todo: Add a network-deny sandbox or proxy guard that fails on public npm, GitHub, or
  other external host access.
