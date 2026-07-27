# 0009: Plan Python Applications During Download

Date: 2026-07-27

## Status

Accepted

## Context

Python application resolution produces an immutable active plan before artifacts can be
downloaded. Requiring operators to invoke `plan` between adding an application and
choosing **Download updates** exposes this internal phase boundary and makes the normal
interactive workflow fail with a missing-file error.

Plans remain valuable as persisted resolver evidence, reproducibility inputs, and
diffable application contracts. The question is whether creating them must be a
separate operator action.

## Decision

1. Workspace-mode `download` performs a Python application plan preflight before
   collecting artifacts.
2. A missing or unreadable active plan is created automatically.
3. A plan is rebuilt automatically when explicit target intent, coverage policy, or
   workspace-local recipe changes.
4. A current plan is reused. `download` does not refresh application versions merely
   because newer index data may exist.
5. `plan --update` remains the explicit operation for refreshing an otherwise current
   plan. `plan --cutoff` remains available for advance review and reproducible
   resolution.
6. Partial `download --target` runs inspect and plan only selected Python application
   targets while retaining their original workspace indexes.
7. `download --dry-run` never writes an active plan. If planning is required, it
   explains that a normal download or explicit `plan` must run first.
8. Planning must complete successfully before artifact collection begins. Incomplete
   requested coverage still prevents activation and download.

## Consequences

- Adding an application followed by **Download updates** is a complete normal workflow.
- The immutable plan format and bundle publication contracts do not change.
- Explicit configuration changes naturally take effect on the next download.
- Repeated downloads avoid resolver work while their active plans remain current.
- Operators who need approval or fixed-cutoff workflows can continue to run `plan`
  separately.
