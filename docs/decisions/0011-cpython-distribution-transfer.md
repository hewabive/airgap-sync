# 0011: CPython Distributions Use A Rolling Transfer Bundle

Date: 2026-08-06

## Status

Accepted. Implementation is split into the phases at the end of this document.

This decision completes the CPython transfer boundary reserved by
[ADR 0010](0010-gitea-pypi-as-python-consumer-interface.md). It replaces the legacy
`python-runtime` target and the ignored `python.artifactTransfer` configuration. Python
package managers, including `uv`, remain ordinary Python applications and are not part
of CPython distribution selection.

## Context

The removable bundle is a temporary transport and working cache with limited capacity.
Gitea is the durable closed-network store. A bundle can be published to several Gitea
instances, and several independently produced bundles can publish to the same Gitea
instance. Online collection therefore cannot depend on destination inventory or on a
record of which destination received an artifact.

Portable CPython distributions have four independent selection dimensions:

- Python minor and patch versions;
- provider build or rebuild identity;
- operating system, architecture, and libc;
- build variant.

Providers can publish one platform before another. A new stable Python minor must be
discovered automatically without making already available platforms wait for the
whole matrix. Conversely, a rolling history window can miss provider builds when the
interval between successful downloads is wider than the configured window.

## Decision

### Separate target and provider

CPython distributions are configured by a first-class `cpython-distributions` target.
The initial provider is `python-build-standalone`. The target contains no `uv` version,
application dependency, install action, or destination-specific state.

The initial supported artifact envelope is:

- CPython major version 3;
- stable, ordinary GIL builds only;
- Windows x86-64 and glibc Linux x86-64;
- `install_only_stripped` archives from `python-build-standalone`.

Additional providers, platforms, and variants require explicit provider adapters and
do not widen this first target implicitly.

### Moving minor boundary

The target declares a fixed lower minor and a moving upper selector:

```json
{
  "series": {
    "major": 3,
    "from": "3.10",
    "through": "latest-stable"
  }
}
```

Every download includes stable minors from the lower boundary through the newest
stable CPython 3 minor visible in provider metadata. A later stable minor is therefore
added automatically. Pre-releases, alternate variants, and a future Python major do
not enter the selection.

### Patch depth and provider-build window

Patch selection has one policy: retain the latest positive number of patches for every
minor and platform independently.

```json
{
  "patches": { "latest": 3 },
  "builds": { "windowDays": 365 }
}
```

`latest: 1`, `latest: 3`, and `latest: 100` have identical semantics with different
depths. There is no separate `all` mode.

For each selected patch and platform, collection includes:

1. the newest matching provider build unconditionally; and
2. every other matching provider build whose provider publication time is within the
   configured `windowDays` duration.

A day is an exact 24-hour duration. Month-based windows are not supported. The newest
build is unconditional so a stable minor does not disappear merely because its
provider has not rebuilt it recently.

The operator can use a wide window for initial seeding and later replace it with a
narrow rolling window. There is one setting; `airgap-sync` does not change it
automatically.

### Progressive platform availability

Selection is evaluated independently for each configured platform. If a patch exists
for Linux but not Windows, Linux is downloaded immediately and Windows continues to
select its newest available patches. A later download discovers and downloads the
Windows artifact after it appears.

The bundle index stores actual artifacts, not persistent placeholders for missing
platform combinations. The current run report may describe unavailable candidates,
but the next run recomputes availability from provider metadata.

### Global successful-download watermark

Every `download` reports the completion time of the most recent successful full
workspace download. The value is derived from run history rather than kept as mutable
workspace configuration.

Run metadata records at least:

- start and completion timestamps;
- `success` or `failed` status;
- `full` or `partial` scope.

Dry runs, failed runs, and `--target` runs do not advance the global watermark. A
partial run must not make unrelated targets appear fresh.

If the elapsed duration is greater than a selected CPython target's `windowDays`, the
preflight explains that provider builds may fall outside the selection. Interactive
use asks whether to continue and defaults to stopping. Non-interactive use stops unless
the operator explicitly accepts the gap. On the first download there is no warning.

This check is advisory protection, not implicit catch-up. An operator who wants the
missed history increases `windowDays`, downloads, transfers, and may later narrow the
window again.

### Local rolling prune and remote additive publication

With rolling bundle retention enabled, a successful full download automatically
removes local CPython artifacts that no longer match any active target. The decision
uses only current target policies and bundle references. It does not consult publish
reports or any Gitea instance.

It is explicitly acceptable for an operator to download an artifact, never publish it,
and later let collection prune it. The removable bundle is not the durable store.

Closed-network publication uploads every artifact present in the current bundle that
is absent at the selected Gitea destination. Publication is additive and idempotent:

- no Gitea package is deleted or reconciled away;
- exact matching remote files are skipped;
- conflicting remote content is an error;
- publish diagnostics never affect later collection or pruning.

`python-build-standalone` artifacts use Gitea Generic Package coordinates that preserve
their provider build and filename. This permits exact archive lookup without making
the local bundle a destination snapshot.

## Bundle records

The initial format uses:

```text
python/distributions/index.json
python/distributions/artifacts/<sha256>/<filename>
python/distributions/fetch-report.json
runs/download/<run-id>/run.json
```

The index is activated only after the selected artifact set has been resolved and all
required downloads have succeeded. It records target references so artifacts shared by
several targets are pruned only after their final reference disappears.

Provider source metadata, resolved publication timestamps, hashes, sizes, platform
identity, Python version, and provider build identity are retained for verification and
publication. Destination URLs and publication receipts are excluded.

## Consequences

- Current Python application completeness remains independent of runtime transfer.
- A small patch depth and narrow build window bound removable-media use.
- A wide initial window can seed Gitea, after which Gitea retains historical artifacts
  while the removable bundle rolls forward.
- Gaps wider than `windowDays` are visible before collection instead of being silently
  mistaken for continuous coverage.
- Progressive platform collection favors availability over an all-platform ready bit.
- Exact historical Python requests outside the retained patch/build policy are not
  guaranteed by the current bundle, even if a previously populated Gitea still has
  them.

## Implementation plan

### Phase 1: decision and contracts

- Commit this ADR and expose its terminology in development documentation.
- Define test fixtures for run history and provider metadata before network code.

### Phase 2: global download history

- Add `run.json` to every non-dry download history directory.
- Derive and display the last successful full-download watermark.
- Add reusable window-gap evaluation and interactive/non-interactive preflight.
- Preserve compatibility with older run directories that have no `run.json`.

### Phase 3: target and selection planner

- Add and validate the `cpython-distributions` workspace target.
- Implement stable minor expansion, per-platform latest-patch depth, and build-window
  selection against captured provider metadata.
- Report progressive platform availability without persisting missing cells.

### Phase 4: bundle acquisition and rolling prune

- Download provider metadata and artifacts resumably with size and SHA-256 checks.
- Activate the CPython distribution index atomically.
- Integrate reference-safe automatic pruning into successful full downloads.
- Extend bundle verification and run history snapshots.

### Phase 5: additive Gitea publication

- Map current CPython artifacts to immutable Gitea Generic Package coordinates.
- Skip matching remote content and reject conflicts.
- Integrate publication reports and top-level publish progress without feeding them
  back into collection.

### Phase 6: legacy removal and acceptance

- Remove `python-runtime`, `python.artifactTransfer`, checked-in runtime catalogs, and
  application-plan CPython/consumer-tool transfer fields.
- Update CLI, migrations, bundle format, architecture, Python support, and examples.
- Run unit, integration, type, lint, format, and unused-export checks.
