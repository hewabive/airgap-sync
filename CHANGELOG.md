# Changelog

## 0.1.0

- Added workspace targets for repeatable removable-media workflows.
- Added an interactive workspace menu for common operator actions and made it the
  default no-argument CLI entrypoint.
- Added recursive npm package collection from package specs, manifests, and lockfiles.
- Added Git target/dependency discovery, mirror fetch, Gitea repository creation, and
  mirror push.
- Added Verdaccio publish with dist-tag restoration and skip-existing checks.
- Added configurable `latest` dist-tag policy for smaller default bundles or
  source-aligned latest mirrors.
- Added static bundle verification, install verification, and local Gitea/Verdaccio e2e testing.
- Added `verify install --ignore-scripts` and documented the tool security model.
- Switched the project development and portable CLI install workflow from pnpm to npm.
