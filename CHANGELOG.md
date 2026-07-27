# Changelog

## 0.1.0

- Added schema-v2 `python-app` targets with application-first Windows/Linux coverage,
  automatic CPython-minor selection, pinned `uv` planning, wheels-only closures,
  inferred glibc boundaries, and collector-independent cross-platform resolution.
- Added immutable Python application plans, content-addressed shared wheels,
  per-platform pylock/requirements locks, external runtime prerequisite contracts,
  plan diffs, reference-safe partial updates/pruning, and bundle verification.
- Made workspace downloads create missing Python application plans automatically,
  rebuild plans invalidated by explicit configuration changes, and reuse current plans.
- Added Gitea Generic Package publication for application plans, consumer contracts,
  locks, and optional hash-verified CPython/uv transfers; production installation
  remains owned by consumer infrastructure using standard pip/uv commands.
- Added broad coverage commands, privacy-limited optional probe diagnostics, the
  application-first interactive menu/settings flow, guided unsupported-coverage
  errors, and Advanced/Legacy placement for raw Python seeding controls.
- Added a maintained KTransformers recipe and captured fixture. Broad native Windows
  coverage is rejected precisely because the reviewed `kt-kernel` release has Linux
  wheels only; Linux planning selects Python 3.11 and infers glibc 2.35.
- Added interrupted download/publication recovery tests, fixed-cutoff reproducibility
  coverage, removable-media bundle benchmarking, and a Python application security
  review.
- Added workspace targets for repeatable removable-media workflows.
- Added automatic, backed-up, atomic workspace migration from schema v1 to schema v2
  when a workspace is opened.
- Added partial workspace downloads for selected targets.
- Made `publish` workspace-aware so it can use `airgap-sync.json` defaults when run
  without bundle, registry, or Gitea arguments.
- Added manifest-based download run change reports so fixed-point updates show which
  package versions and requirement mappings changed.
- Added a registry metadata cache for repeated downloads so already-bundled exact
  package versions can skip source-registry metadata lookups.
- Fixed download Git mirror reporting so changes from earlier fixed-point iterations
  are preserved in the final summary and `git-fetch-report.json`.
- Added automatic pnpm toolchain collection for Git/local manifests that declare
  `packageManager` or `devEngines.packageManager`. Both `pnpm` and the standalone
  `@pnpm/exe` bootstrap package are included even when `package.json` is covered by a
  lockfile, and bundle verification now reports missing bootstrap packages.
- Fixed download npm reporting so packages downloaded in earlier fixed-point iterations
  are preserved in the final `fetch-report.json`.
- Avoided repeated Git mirror fetches during download iterations when the Git source
  set has not changed.
- Added `npm run update:run` for Git checkout refresh, install, build, and CLI launch.
- Added an interactive workspace menu for common operator actions and made it the
  default no-argument CLI entrypoint.
- Added Python/PyPI configuration to the interactive workspace initializer and settings
  menu, including target environment add, edit, and remove actions.
- Added per-target Python resolution modes for Git, PyPI, and exact root-wheel targets,
  with workspace-default inheritance and a run-wide CLI override.
- Fixed concise download summaries to count and display Python resolution errors.
- Added recursive npm package collection from package specs, manifests, and lockfiles.
- Added Git target/dependency discovery, mirror fetch, Gitea repository creation, and
  mirror push.
- Added per-command Git `safe.directory` handling for bundle mirrors moved between
  Windows machines.
- Added Verdaccio publish with dist-tag restoration and skip-existing checks.
- Added configurable `latest` dist-tag policy for smaller default bundles or
  source-aligned latest mirrors.
- Changed bundled latest handling so generated latest decisions are computed during
  publish instead of stored as hundreds of entries in `dist-tags.json`.
- Added stable tag dependency reuse so repeated downloads do not follow moved tags when
  the declaring parent did not change.
- Added static bundle verification, install verification, and local Gitea/Verdaccio e2e testing.
- Added `verify install --ignore-scripts` and documented the tool security model.
- Changed pnpm install verification to trust loaded lockfiles so Verdaccio import time
  does not trip pnpm v11 `minimumReleaseAge`.
- Documented closed-network handling for native install scripts that fetch prebuilds or
  Node headers outside the npm registry, including pnpm-compatible `.npmrc`
  configuration and `approve-builds` environment requirements.
- Switched the project development and portable CLI install workflow from pnpm to npm.
