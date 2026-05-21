# Roadmap

The current implementation started as a Verdaccio seed tool. The direction is now a
larger airgap sync workflow that coordinates Git repository transfer, npm registry
package transfer, Git dependencies found inside npm package graphs, and offline
verification.

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
- Add package existence pre-checks and concurrency.

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

## Milestone 6: Git Repository Orchestration

- Scan a removable-media directory for Git repositories.
- Refresh repositories on the online side using safe fetch/pull policies.
- Run repository refresh before dependency collection.
- Mirror or bundle repositories for transfer into a closed network.
- Push mirrors into Gitea without accidentally deleting protected refs.
- Generate `insteadOf` rules for closed-network installs.

## Milestone 7: Git Dependencies in Node Graphs

- Preserve `requiredBy` for unsupported Git specs in fetch reports.
- Parse npm Git specs into canonical repository URL and commit/tag selectors.
- Store source Git identities in the online bundle without binding them to a specific
  Gitea instance.
- Fetch local bare mirrors for Git dependencies discovered in transitive npm package
  manifests.
- Re-run npm dependency collection when newly mirrored Git repositories expose
  additional package manifests.
- Preserve upstream owner/repository paths when mapping mirrors into Gitea.
- Create missing Gitea owners/repositories during the offline apply phase.
- Push local bare mirrors to planned Gitea target URLs and emit broad `insteadOf` rules
  when preserved paths make that safe.
- Configure Git `insteadOf` rewrite rules from the transfer bundle.
- Recursively inspect package manifests from Git dependencies.
- Decide when URL rewriting is enough and when package/lockfile patching is required.

## Milestone 8: End-to-End Verification

- Create a closed-network install sandbox.
- Force npm registry access through Verdaccio.
- Force Git access through Gitea rewrite rules.
- Fail if install attempts to reach public npm, GitHub, or other external hosts.
