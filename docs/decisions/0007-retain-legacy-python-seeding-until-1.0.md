# 0007: Retain Legacy Python Seeding Until 1.0

Date: 2026-07-27

## Status

Accepted, amended by [ADR 0008](0008-automatic-workspace-migrations.md) and
[ADR 0010](0010-gitea-pypi-as-python-consumer-interface.md).

ADR 0008 supersedes decision 1 below: schema-v1 files are now migrated automatically
when opened. ADR 0010 replaces the former lock-first application consumer contract;
decisions retaining lower-level legacy target types and their resolver remain active.

## Context

`python-app` is the normal way to request repository coverage for an application, but
existing schema-v1 workspaces and the `pypi`, `python-wheel`, and `python-runtime`
targets are already in use. They solve lower-level package-transfer cases that are not
automatically equivalent to an application compatibility policy. Removing them during
the repository-model migration would turn an architecture correction into an
unbounded data migration.

The schema-v2 reader already preserves legacy seeding under `python.legacySeed`, the
interactive UI places it under Advanced/Legacy, and `migrate --dry-run` can show a
schema-v2 representation without changing the workspace.

## Decision

1. Keep executing migrated schema-v1 Python intent for every `0.x` release. Persisted
   schema-v1 workspaces are upgraded to schema v2 when opened.
2. Keep `pypi`, `python-wheel`, `python-runtime`, and
   `--allow-approximate-python` available as Advanced/Legacy operations during that
   period.
3. Do not add new normal-flow features to the legacy resolver. Correctness and UX work
   goes to `python-app` and the Gitea PyPI repository-coverage path.
4. The earliest release allowed to remove legacy seeding is `1.0.0`.
5. Removal still requires a separate ADR and all of these prerequisites:
   - a write-capable, backed-up schema migration path;
   - at least two published `0.x` releases with `python-app` and ordinary Gitea PyPI
     installation as the default workflow;
   - application recipes or exact-wheel escape hatches for known production inputs;
   - documentation for legacy cases that cannot be represented automatically;
   - a release note that treats removal as a breaking change.
6. Until those prerequisites are met, legacy fields remain supported rather than
   merely parsed.

## Consequences

- Existing removable-media workspace behavior is preserved after an automatic,
  backed-up schema migration.
- New workspaces use schema v2 and repository-oriented application defaults.
- The code temporarily carries both planners and bundle compatibility manifests.
- `1.0.0` is an eligibility boundary, not an automatic deletion date.
