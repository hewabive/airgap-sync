# 0010: Gitea PyPI Is The Python Consumer Interface

Date: 2026-08-05

## Status

Accepted. Implementation migration is in progress.

This decision replaces the normal Python workflow from the removed ADRs 0005, 0006,
and 0009. Git history retains those earlier lock-first and application-plan decisions.

## Context

The first Python application design made an immutable environment plan and generated
lock the primary consumer contract. It also mixed package repository coverage with
optional transfer of CPython archives and consumer `uv` executables.

The actual deployment boundary is simpler. `airgap-sync` can publish only through
Gitea, and consumer machines are independently managed. A consumer should be able to
configure the Gitea PyPI Simple API and use a standard Python client without knowing
about `airgap-sync` plans or its resolver version.

A completely unknown fleet and literally arbitrary installation method cannot be
covered by a finite minimal bundle. Artifact compatibility depends on operating system,
architecture, Python version and ABI, libc, selected extras, and artifact-changing
application features. The product must therefore make a bounded compatibility envelope
explicit.

## Decision

1. Gitea PyPI is the normal consumer-facing interface for Python applications.
2. Standard clients resolve dependencies from Gitea. Generated locks are optional
   audit and frozen-install artifacts, not a prerequisite for repository correctness.
3. The initial maximum compatibility envelope is CPython 3.10–3.13 on Windows x86-64
   and glibc-based Linux x86-64.
4. `airgap-sync` guarantees Python artifact availability only inside the declared
   envelope. System libraries, drivers, services, model weights, and non-PyPI package
   ecosystems remain outside the guarantee.
5. Collection remains wheels-only by default. Missing compatible wheels produce a
   coverage failure or require an explicitly supplied reviewed wheel; source builds are
   not executed automatically.
6. A pinned collector resolver may discover candidate closures, but its version is an
   internal implementation detail. Consumer package-manager versions do not create
   separate application dependency trees.
7. Planning must validate ordinary resolution against the exact sparse repository that
   consumers will see, including the effect of destination state or an isolated
   destination namespace. The repository closure is complete only at a fixed point.
8. Artifact selection minimizes the content-addressed union that covers the declared
   environments. It does not download every compatible build when fewer wheels provide
   the same coverage.
9. CPython runtimes and package-manager executables are separate optional transfer
   concerns. Their future target/configuration model will be decided independently.
10. Primary end-to-end verification installs an application without an
    `airgap-sync`-specific lock using representative `pip` and `uv` clients configured
    only with the Gitea index.

## Consequences

- Existing index, metadata, wheel-validation, download, deduplication, and Gitea
  publication machinery remains useful.
- Current generated plans and locks can remain internal evidence during migration.
- `python.artifactTransfer.uvVersions`, default CPython transfer, lock-only consumer
  commands, and `all-compatible` collection are transitional behavior.
- Supporting more platforms or Python versions expands an explicit compatibility
  envelope and must expose its incremental size.
- A shared append-only Gitea namespace is part of resolution state and cannot be
  ignored. The implementation needs either destination-aware closure validation or
  isolated publication channels.
- Application recipes remain optional policy adapters. Complex applications are test
  cases, not special product modes.

See [Python Support](../python.md) for the normative product contract and migration
sequence.
