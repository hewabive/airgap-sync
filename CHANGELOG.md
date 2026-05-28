# Changelog

## 0.1.0

- Added workspace targets for repeatable removable-media workflows.
- Added partial workspace downloads for selected targets.
- Added `npm run update:run` for Git checkout refresh, install, build, and CLI launch.
- Added an interactive workspace menu for common operator actions and made it the
  default no-argument CLI entrypoint.
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
