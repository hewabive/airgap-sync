# 0010: Gitea PyPI Is The Python Consumer Interface

Date: 2026-08-05

## Status

Accepted and implemented for the normal Python application path. The separate CPython
transfer decision reserved here is implemented by
[ADR 0011](0011-cpython-distribution-transfer.md).

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
   audit and frozen-install artifacts, not a prerequisite for bundle completeness.
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
7. Every application target must contribute a complete recursive dependency tree for
   every retained compatibility cell. No dependency edge may rely on the public index
   after transfer.
8. There is no requirement to reproduce the collector's exact graph during consumer
   installation. Standard clients may select any installable graph available in the
   shared Gitea owner.
9. Artifact selection minimizes the content-addressed union that covers the declared
   environments. It does not download every compatible build when fewer wheels provide
   the same coverage.
10. Targets and parent references describe only the local transfer bundle. After a
    successful publish, an operator may remove a one-time target and prune locally
    unreferenced artifacts without deleting the packages from Gitea.
11. Multiple independent `airgap-sync` workspaces and other publishers may add packages
    to the same Gitea owner. `airgap-sync` does not inventory, reconcile, or exclusively
    control that owner; additive packages do not invalidate an already delivered tree.
12. CPython runtimes and package-manager executables are separate optional transfer
    concerns. Their future target/configuration model will be decided independently.
13. Primary end-to-end verification installs an application without an
    `airgap-sync`-specific lock using representative `pip` and `uv` clients configured
    only with an index populated from the bundle.

## Consequences

- Existing index, metadata, wheel-validation, download, deduplication, and Gitea
  publication machinery remains useful.
- Generated plans and locks remain internal evidence and optional diagnostics.
- Normal workspaces use minimum-cover application collection and transfer no CPython
  or consumer package-manager executable through application plans. ADR 0011 removes
  `python.artifactTransfer` and introduces independent CPython distribution targets.
- Supporting more platforms or Python versions expands an explicit compatibility
  envelope and must expose its incremental size.
- A shared additive Gitea owner needs no destination snapshot or single-writer policy.
  Deleting, replacing, or corrupting previously published artifacts is a separate
  registry-administration concern.
- Python target removal and local pruning should follow the established npm ownership
  model: artifacts remain while another active target references them, while remote
  registry state is left untouched.
- Application recipes remain optional policy adapters. Complex applications are test
  cases, not special product modes.

See [Python Support](../python.md) for the normative product contract and migration
sequence.
