# Changelog

## 0.1.0

- Added fail-closed npm supply-chain controls: registry SRI/SHA-1 verification,
  schema-v2 SHA-256 manifests, a configurable release-age quarantine, exact-version
  OSV malware checks, lifecycle/non-registry dependency inspection with digest-pinned
  approvals, fresh security evidence required by verify/publish, and script-free
  install verification by default.
- Combined npm hashing and manifest inspection into one streaming tarball pass and
  reused unchanged results within each download or verify run, reducing removable-media
  reads without persisting trust across commands.
- Fixed CPython discovery failures caused by oversized GitHub release-list responses.
  Provider metadata now uses bounded pages, retries transient HTTP/network failures,
  honors server retry delays, and reports retry progress through `download`.
- Added a common type-aware target editing API, `target edit <index>` command, and
  interactive editor. CPython rolling-policy fields can be changed in place; immutable
  target types report that they have no editable settings. The former Python-specific
  set commands remain deprecated compatibility aliases.
- Added first-class `cpython-distributions` targets backed by
  `python-build-standalone`, with automatic discovery of new stable CPython 3 minors,
  independently evaluated per-platform latest-patch depth, and exact-day provider-build
  windows.
- Added resumable, verified, content-addressed CPython distribution acquisition,
  atomic bundle activation, reference-safe rolling prune, static verification, bundle
  summaries, and additive idempotent publication to Gitea Generic Packages.
- Added global successful full-download history and a watermark warning that prevents
  a CPython build window from silently skipping releases after a long collection gap.
  Partial, failed, and dry-run downloads do not advance the watermark.
- Removed the unused `python-runtime` target, `python.artifactTransfer`, checked-in
  runtime catalogs, and application-plan CPython/consumer-tool artifact transfer.
  Package managers such as `uv` remain independent ordinary Python applications.
- Added composable Python application version selectors so one target can require exact
  releases together with `latest`, validate every selector against the full requested
  Python/platform wheel closure, and publish one independently locked variant per
  resolved version while deduplicating shared artifacts.
- Added an optional Gitea token prompt to interactive first-time workspace setup so
  publish credentials can be saved without visiting the settings menu.
- Made the collector's pinned uv an internal planning tool; normal application targets
  no longer ask for consumer uv versions or transfer CPython/uv executables.
- Added repeatable `python-app --python-version` selection and complete matrix planning,
  defaulting new targets to CPython 3.10–3.13 and retaining one resolved tree per
  requested platform/Python cell.
- Added exact compatibility-cell references and minimum practical wheel-cover
  selection so universal and `abi3` wheels are shared while redundant builds are
  omitted.
- Added the persistent `defaults.publish.provisionGit` workspace setting, defaulting to
  `true`, with `false` and `"ask"` behavior matching the other interactive defaults.
- Added schema-v2 `python-app` targets with application-first Windows/Linux coverage,
  explicit CPython-minor selection, pinned internal `uv` planning, wheels-only
  closures, inferred glibc boundaries, and collector-independent cross-platform
  resolution.
- Added immutable Python application plans, content-addressed shared wheels,
  per-platform pylock/requirements locks, external runtime prerequisite contracts,
  plan diffs, reference-safe partial updates/pruning, and bundle verification.
- Made workspace downloads create missing Python application plans automatically,
  rebuild plans invalidated by explicit configuration changes, and reuse current plans.
- Added optional Gitea Generic Package publication for application plans, consumer
  contracts, locks, and evidence documents. It is disabled by default; Gitea PyPI is
  sufficient for production installation with standard pip/uv commands.
- Serialized identical Generic Package blob uploads across application packages to
  avoid Gitea PostgreSQL `UQE_package_blob_md5` races while retaining parallel uploads
  for different content.
- Added broad coverage commands, privacy-limited optional probe diagnostics, the
  application-first interactive menu/settings flow, guided unsupported-coverage
  errors, and Advanced/Legacy placement for raw Python seeding controls.
- Added a maintained KTransformers recipe and captured fixture. Broad native Windows
  coverage is rejected precisely because the reviewed `kt-kernel` release has Linux
  wheels only; Linux planning selects Python 3.11 and infers glibc 2.35.
- Added interrupted download/publication recovery tests, fixed-cutoff planning tests,
  removable-media bundle benchmarking, and a Python application security review.
- Added workspace targets for repeatable removable-media workflows.
- Added automatic, backed-up, atomic workspace migration from schema v1 to schema v2
  when a workspace is opened.
- Added partial workspace downloads for selected targets.
- Fixed partial workspace downloads so previously active unselected Git sources remain
  publishable and workspace snapshots retain the complete configured target list.
- Made workspace downloads activate `git-sources.json` and `workspace-snapshot.json`
  only after a successful run; failed attempts retain the last active metadata while
  still writing diagnostic reports.
- Added a fail-fast Git publication preflight that rejects multiple source IDs mapped
  to the same case-insensitive Gitea owner/repository before provisioning or pushing.
- Made `publish` workspace-aware so it can use `airgap-sync.json` defaults when run
  without bundle, registry, or Gitea arguments.
- Added manifest-based download run change reports so fixed-point updates show which
  package versions and requirement mappings changed.
- Added a registry metadata cache for repeated downloads so already-bundled exact
  package versions can skip source-registry metadata lookups.
- Made repeated Python publication query Gitea's compact Simple Index in parallel and
  skip exact filename/SHA-256 matches without uploading or downloading wheel bodies.
- Fixed download Git mirror reporting so changes from earlier fixed-point iterations
  are preserved in the final summary and `git-fetch-report.json`.
- Fixed bare Git mirror `HEAD` synchronization with the upstream default branch.
  Existing mirrors with stale or dangling `HEAD` references are repaired automatically
  during their next fetch.
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
- Added static bundle verification, bundle-only unlocked pip/uv install verification,
  and local Gitea/Verdaccio e2e testing.
- Added `verify install --ignore-scripts` and documented the tool security model.
- Changed pnpm install verification to trust loaded lockfiles so Verdaccio import time
  does not trip pnpm v11 `minimumReleaseAge`.
- Documented closed-network handling for native install scripts that fetch prebuilds or
  Node headers outside the npm registry, including pnpm-compatible `.npmrc`
  configuration and `approve-builds` environment requirements.
- Switched the project development and portable CLI install workflow from pnpm to npm.
