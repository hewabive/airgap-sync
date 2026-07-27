# 0007: Retain Legacy Python Seeding Until 1.0

Date: 2026-07-27

## Status

Accepted

## Context

ADR 0006 makes `python-app` the normal Python workflow, but existing schema-v1
workspaces and the `pypi`, `python-wheel`, and `python-runtime` targets are already in
use. They solve lower-level package-transfer cases that are not automatically
equivalent to an application coverage policy. Removing them during the application
cutover would turn a usability refactor into an unbounded migration.

The schema-v2 reader already preserves legacy seeding under `python.legacySeed`, the
interactive UI places it under Advanced/Legacy, and `migrate --dry-run` can show a
schema-v2 representation without changing the workspace.

## Decision

1. Keep reading and executing schema-v1 Python configuration for every `0.x` release.
2. Keep `pypi`, `python-wheel`, `python-runtime`, and
   `--allow-approximate-python` available as Advanced/Legacy operations during that
   period.
3. Do not add new normal-flow features to the legacy resolver. Correctness and UX work
   goes to `python-app`.
4. The earliest release allowed to remove legacy seeding is `1.0.0`.
5. Removal still requires a separate ADR and all of these prerequisites:
   - a write-capable, backed-up schema migration command;
   - at least two published `0.x` releases with `python-app` as the default workflow;
   - application recipes or exact-wheel escape hatches for known production inputs;
   - documentation for legacy cases that cannot be represented automatically;
   - a release note that treats removal as a breaking change.
6. Until those prerequisites are met, legacy fields remain supported rather than
   merely parsed.

## Consequences

- Existing removable-media workspaces continue to run unchanged.
- New workspaces use schema v2 and application-first defaults.
- The code temporarily carries both planners and bundle compatibility manifests.
- `1.0.0` is an eligibility boundary, not an automatic deletion date.
