# Workflows

This document describes the current manual end-to-end workflow. The commands are kept
separate on purpose: each phase writes reports that can be inspected before the next
phase mutates Verdaccio, Gitea, or Git configuration.

## Assumptions

- The online machine can reach the source npm registry and public Git hosts.
- The transfer bundle directory is on removable media or can be copied to it.
- The closed network has Verdaccio and Gitea running.
- Verdaccio is populated only through `npm publish` and `npm dist-tag`.
- Gitea target repositories either can be created through the Gitea API or already
  exist.

Example names used below:

```text
./seed                         Transfer bundle directory
https://registry.npmjs.org     Source npm registry
http://verdaccio.local:4873    Closed-network npm registry
http://gitea.local             Closed-network Gitea base URL
npm-mirrors                    Gitea user or organization for dependency mirrors
```

## Online Phase

Build the npm seed bundle from a project manifest:

```bash
airgap-sync fetch \
  --manifest ./package.json \
  --include-dev \
  --registry https://registry.npmjs.org \
  --output ./seed
```

For production-only dependency closure, omit `--include-dev`.

The fetch step writes:

- `seed-manifest.json`
- `dist-tags.json`
- `fetch-report.json`
- package tarballs under `packages/`

Create the Git mirror plan from Git dependencies found in npm package manifests:

```bash
airgap-sync git plan ./seed \
  --gitea http://gitea.local \
  --owner npm-mirrors \
  --write
```

If the Gitea owner is an organization, the owner name is still written here; the owner
type is selected later during repository creation.

Fetch local bare mirrors for the planned Git dependencies:

```bash
airgap-sync git fetch ./seed
```

This creates or updates local bare repositories under `./seed/git-mirrors/` and writes
`git-fetch-report.json`.

Before transfer, inspect the bundle:

```bash
airgap-sync info ./seed
```

Also check:

- `fetch-report.json` for unresolved registry packages and unsupported specs;
- `git-plan.json` for planned Gitea target URLs;
- `git-fetch-report.json` for clone/update errors.

## Transfer Phase

Copy the whole `./seed` directory to the closed network, including:

- `packages/`
- `git-mirrors/`
- `seed-manifest.json`
- `dist-tags.json`
- `fetch-report.json`
- `git-plan.json`
- `git-fetch-report.json`

Do not copy only tarballs. The JSON files are the audit trail and are required by later
commands.

## Offline Phase

Publish npm packages and restore dist-tags into Verdaccio:

```bash
airgap-sync publish ./seed \
  --registry http://verdaccio.local:4873
```

This writes `publish-report.json`.

Create missing Gitea repositories from the plan:

```bash
export GITEA_TOKEN=...

airgap-sync git create-repos ./seed \
  --token "$GITEA_TOKEN"
```

For a Gitea organization:

```bash
airgap-sync git create-repos ./seed \
  --owner-type org \
  --token "$GITEA_TOKEN"
```

By default repositories are private. Use `--public` only when the mirror repositories
should be public inside the closed network.

Push local bare mirrors into Gitea:

```bash
airgap-sync git apply ./seed
```

This writes `git-apply-report.json`.

Configure Git URL rewrites so installs that reference public Git URLs resolve through
Gitea:

```bash
airgap-sync git config ./seed --global
```

This writes `git-config-report.json` and applies rules like:

```bash
git config --global \
  url."http://gitea.local/npm-mirrors/github.com-owner-repo.git".insteadOf \
  "https://github.com/owner/repo.git"
```

## Install Check

Run the normal package-manager install against Verdaccio:

```bash
npm ci --registry http://verdaccio.local:4873
pnpm install --frozen-lockfile --registry http://verdaccio.local:4873
```

If install still tries to reach the public internet, inspect:

- Git errors: check `git-plan.json`, `git-apply-report.json`, and
  `git-config-report.json`.
- Missing npm versions or tags: check `publish-report.json` and `dist-tags.json`.
- Unsupported specs: check `fetch-report.json`.

## Dry Runs

Most mutating Git steps support dry-run:

```bash
airgap-sync git fetch ./seed --dry-run
airgap-sync git create-repos ./seed --dry-run
airgap-sync git apply ./seed --dry-run
airgap-sync git config ./seed --global --dry-run
```

`airgap-sync publish ./seed --dry-run --registry http://verdaccio.local:4873` prints the
planned npm publish and dist-tag operations without publishing.

## Current Gaps

- There is no single `collect` command yet; use `fetch`, `git plan`, and `git fetch`.
- There is no single `apply` command yet; use `publish`, `git create-repos`,
  `git apply`, and `git config`.
- There is no automated external-network verification yet. The next milestone is a
  `verify` command that runs installs in a controlled environment and fails on public
  npm or Git access attempts.
