# 0001: Build a Separate Tool

Date: 2026-05-20

## Status

Accepted

## Context

`pnpm-airgap` is lockfile-first: it reads `pnpm-lock.yaml`, downloads exact tarballs,
and publishes them to a registry.

The target problem here is different. We need to seed a registry so that standard
install commands can resolve dependencies through registry metadata, including
`dist-tags`.

## Decision

Create `airgap-sync` as a separate package instead of extending `pnpm-airgap`.

## Consequences

- The tool can serve npm, pnpm, and other npm-compatible clients.
- The resolver can be designed around npm registry metadata from the start.
- `pnpm-airgap` remains a focused lockfile transfer tool.
- Some implementation ideas can still be reused: bundle reports, publish safety checks,
  concurrency limits, and Verdaccio-focused documentation.
