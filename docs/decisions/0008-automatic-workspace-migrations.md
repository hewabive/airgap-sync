# 0008: Apply Workspace Migrations When Opening a Workspace

Date: 2026-07-27

## Status

Accepted. Superseded for `python-runtime` compatibility by
[ADR 0011](0011-cpython-distribution-transfer.md).

Amends the schema-v1 lifetime decision in
[ADR 0007](0007-retain-legacy-python-seeding-until-1.0.md). Legacy Python target
behavior remains supported, but its persisted workspace representation is migrated to
schema v2.

ADR 0011 later removes the unused `python-runtime` target and legacy transfer fields;
the automatic migration mechanism and other legacy Python targets remain unchanged.

## Context

New Python application targets require workspace schema v2. Requiring an operator to
discover and run a preview-only migration command makes the normal interactive
workflow fail before it can add an application. It also leaves schema compatibility
branches spread through workspace consumers.

`airgap-sync` is a CLI rather than a long-running server, and one installation can open
different removable-media workspaces. Its migration boundary is therefore opening a
specific workspace, not process startup before command arguments are known.

## Decision

1. Opening a workspace runs an ordered registry of configuration migrations before
   returning configuration to menu, CLI, or library business logic.
2. Each migration has a stable ordered id, an `isApplied` predicate, and an idempotent
   transform. The initial migration is `0001-workspace-schema-v2`.
3. A schema-v1 file is fully parsed and the schema-v2 result is validated before any
   persistent state changes.
4. Before applying the first migration, preserve the exact source bytes as
   `airgap-sync.json.v1.backup`. Never overwrite an existing backup.
5. Install required schema-v2 workspace scaffolding, then replace
   `airgap-sync.json` atomically. An interrupted run is safe to retry.
6. The interactive menu reports migrations applied while opening the workspace.
7. `migrate --dry-run` bypasses automatic application and remains available to inspect
   the final current-schema representation without writing it.
8. This historical decision retained `pypi`, `python-wheel`, and `python-runtime`
   targets through `python.legacySeed`; ADR 0012 later removes that behavior.
9. Migration does not invent application platform coverage from exact legacy Python
   environments. When a migrated workspace first adds a Python application, the menu
   asks for broad Windows/Linux coverage.

## Consequences

- Existing workspaces become usable with the repository-oriented application menu on
  their next open, without an operator migration step.
- Reopening an already migrated workspace is a no-op.
- Restoring schema v1 for an older `airgap-sync` binary is a deliberate manual rollback
  from the backup.
- Future persisted workspace format changes must add an ordered, validated,
  idempotent migration rather than a permanent read-time compatibility shim.
- Compatibility branches for schema v1 can be removed after all supported entry points
  operate through the migration boundary; legacy target behavior remains until its
  separate 1.0 decision.
