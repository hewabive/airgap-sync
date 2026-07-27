# 0006: Application-First Python Publishing

Date: 2026-07-27

## Status

Accepted

Supersedes the resolver and explicit-environment decisions in
[ADR 0005](0005-python-package-transfer-without-python.md). ADR 0005 remains normative
for publish-only operation, wheels-only collection, artifact integrity, Gitea PyPI
publication, and compatibility with existing Python seed targets.

## Context

The first Python implementation mirrors package closures for explicitly configured
Python environments. That is useful for expert package seeding, but it requires an
operator to choose Python patch versions, platform tags, libc baselines, and a
simplified resolution mode before the tool can answer the application-level question:
“What can be published for this fleet?”

The collector host is not a target environment. It must remain possible to collect
Windows artifacts on Linux and target architectures that differ from the collector.
Production installation also remains outside `airgap-sync`, just as npm consumers use
their normal package manager after packages have been published to Verdaccio.

## Decision

1. Add a new `python-app` path beside the existing Python seed path. It accepts an
   application intent and a bounded platform coverage policy.
2. Initial platform families are `windows-x86_64` and
   `linux-glibc-x86_64`. Families describe package compatibility, not physical hosts or
   Linux distribution names. The domain is explicitly collector-independent and can
   add target architectures without running on them.
3. The default wheel policy is `all-compatible`: after package versions are locked,
   collect every wheel matching the requested OS families, architectures, selected
   Python minor, and supported ABIs. Do not expand to other versions, Python minors,
   architectures, sdists, or accelerator indexes.
4. Use a pinned standalone `uv` executable as the application-path backtracking
   resolver. The initial pin is `0.11.16`. Acquire the executable for the collector,
   verify its SHA-256 against the checked-in tool manifest, and keep target selection
   independent from the collector executable.
5. Invoke `uv` with explicit Python version, target platform, wheels-only policy, and
   isolated cache/config paths. Source builds are not an application-path fallback.
6. Treat `uv` machine-readable `pylock.toml` output as resolver evidence, then validate
   metadata, wheel tags, hashes, and artifact policy in TypeScript. Generate the final
   index-neutral, per-platform `requirements.lock` in TypeScript.
7. Do not use the raw hash set from `uv pip compile --generate-hashes` as the consumer
   lock. The executable spike demonstrated that it can contain hashes for files outside
   the selected platform. Consumer locks contain only artifacts accepted by the
   environment plan.
8. For glibc Linux, search a versioned set of manylinux floors from older to newer,
   retain the broadest complete closure, and report its minimum glibc. Distribution
   names are optional presentation hints, never resolver inputs.
9. Publish wheels to Gitea PyPI. Publish environment plans, locks, reports, and optional
   runtime/tool archives to Gitea Generic Packages. Publishing an incomplete requested
   coverage set requires an explicit replan with narrower coverage; partial coverage is
   never silently activated.
10. `airgap-sync` does not install or manage production Python environments. It emits
    runtime prerequisites and standard `pip`/`uv` commands. `verify install` may
    reproduce the consumer workflow in a temporary compatible environment.
11. Existing `pypi`, `python-wheel`, `python-runtime`, schema-v1 environment fields,
    manifests, and publication continue to work throughout the migration.

## Executable Spike

`npm run spike:python-planner`:

- acquires and hash-verifies the pinned collector-native `uv`;
- resolves a native-wheel fixture for Windows and multiple manylinux targets without
  using the collector as the target;
- emits deterministic `pylock.toml`;
- verifies that each output contains a wheel for the requested platform;
- confirms that raw generated requirements hashes are intentionally not the final
  consumer-lock representation.

The spike is network-backed and is not part of the regular offline test suite.

## Licensing And Trust

`uv` is dual-licensed under Apache-2.0 or MIT. The tool manifest pins release asset
URLs, sizes, SHA-256 values, license URLs, and license-file hashes. A later artifact
transfer phase must place the applicable license text beside any redistributed binary.
Updates to the pin are explicit reviewed changes.

## Consequences

- Normal users select applications and broad platform coverage, not wheel tags.
- Resolver correctness no longer depends on the simplified TypeScript resolver.
- Bundle size grows with requested coverage, but plans report incremental bytes and
  expansion is bounded.
- Locks are platform-specific while wheel storage and registry publication are
  deduplicated.
- A full Linux distribution catalog is unnecessary. Unknown distributions remain
  usable when their libc family/version satisfies the plan.
- Cross-platform collection remains supported; install verification requires a
  compatible runner and otherwise records a skip.
