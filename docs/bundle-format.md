# Bundle Format

An airgap bundle is a directory that can be transferred to the target environment.
The Python portion below documents the current pre-1.0 on-disk format. Plans and locks
are collector evidence, not requirements for a machine installing from Gitea PyPI.
The repository contract is defined in [Python Support](python.md).

```text
airgap-bundle/
  packages/
    foo-1.0.0.tgz
    scope__bar-2.0.0.tgz
  python-packages/
    requests-2.32.4-py3-none-any.whl
  python/
    application-index.json
    applications/
      <application>--<coverage>/
        environment-plan.json
        plan-diff.json
        prerequisites.json
        lock/
    artifacts/
      wheels/<sha256>/<filename>.whl
    distributions/
      index.json
      fetch-report.json
      publish-report.json
      artifacts/<sha256>/<filename>.tar.gz
    publications/
      <publication-id>/
        publication-manifest.json
        applications/
          <application>--<coverage>/
            consumer-contract.json
            consumer.env.template
            pip.conf.template
  seed-manifest.json
  dist-tags.json
  security-report.json
  python-security-report.json
  registry-metadata-cache.json
  workspace-snapshot.json
  fetch-report.json
  publish-report.json
  python-seed-manifest.json
  python-metadata-cache.json
  python-fetch-report.json
  python-publish-report.json
  runs/
    download/
      20260520T000000000Z/
        seed-manifest.before.json
        seed-manifest.after.json
        dist-tags.before.json
        dist-tags.after.json
        fetch-report.json
        collect-report.json
        prune-report.json
        package-changes.json
        resolution-changes.json
    publish/
      20260520T010000000Z/
        apply-report.json
        publish-report.json
        git-apply-report.json
```

## seed-manifest.json

Describes every tarball in the bundle and why it was included. A package can have
multiple `resolvedFrom` entries when the same `name@version` satisfies several
lockfile entries, manifest dependencies, or stable reused range/tag requirements.

```json
{
  "schemaVersion": 2,
  "createdAt": "2026-05-20T00:00:00.000Z",
  "sourceRegistry": "https://registry.npmjs.org",
  "packages": [
    {
      "name": "foo",
      "version": "1.0.0",
      "file": "packages/foo-1.0.0.tgz",
      "integrity": "sha512-...",
      "sha256": "0123456789abcdef...",
      "shasum": "0123456789abcdef...",
      "publishedAt": "2026-05-01T00:00:00.000Z",
      "tarball": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",
      "resolvedFrom": [
        {
          "type": "range",
          "raw": "foo@^1.0.0",
          "specifier": "^1.0.0",
          "requiredBy": "root"
        }
      ]
    }
  ]
}
```

Schema 2 requires a SHA-256 for every npm tarball. Registry SRI/SHA-1 and publication
time are retained when supplied. Schema-1 manifests remain readable for diagnostics,
but strict verification and npm publication refuse them because their bytes cannot be
bound to security evidence.

The runtime inspection cache is intentionally not part of the bundle. During one
download or verify process, SHA-256, required registry digests, and the embedded
`package.json` are produced by one streaming read and reused while the file fingerprint
is unchanged. A later process re-reads the content, preserving the transfer and
publication trust boundaries.

## security-report.json

Records the exact-version OSV query and static tarball inspection result. Its
`manifestSha256` is the canonical SHA-256 of the complete `seed-manifest.json`; publish
requires `ok: true`, an exact digest match, and a report no older than the policy TTL.
Malware advisories, scanner errors, lifecycle scripts, and non-registry dependencies
block the report. Ordinary vulnerability advisories are warnings. Static exceptions
record an exact `name@version#sha256:<hex>` approval. A failed scan is written as
`security-report.failed.json` so it cannot replace previously active evidence.

## dist-tags.json

Records real tags required by package specs, such as `foo@latest`, `foo@next`, or
`node-fetch@cjs`. In `latestPolicy: "bundled"` mode, computed publish-time `latest`
tags are not stored here; publish derives them from `seed-manifest.json`. On repeated
downloads, `airgap-sync` can also use this file as the previous bundle's stable tag
map: reuse requires the same `name`, `tag`, and `requiredBy` plus a still-present
mapped tarball.

```json
{
  "schemaVersion": 1,
  "sourceRegistry": "https://registry.npmjs.org",
  "createdAt": "2026-05-20T00:00:00.000Z",
  "tags": {
    "foo": {
      "latest": "1.0.0"
    }
  },
  "requirements": [
    {
      "name": "foo",
      "tag": "latest",
      "version": "1.0.0",
      "requiredBy": "root"
    }
  ]
}
```

## registry-metadata-cache.json

Caches the registry metadata needed to traverse dependencies for package versions that
are already present in the bundle. It is an optimization for repeated downloads: exact
`package@version` requirements whose tarballs still exist can be resolved from this
file instead of issuing another source-registry metadata request. Root tags and ranges,
and refreshed transitive tags/ranges, still resolve through the source registry so normal
update discovery is preserved.

## python-seed-manifest.json

Records the authoritative offline publish inputs for Python. Each package has an exact
version, one or more wheel files, parsed Core Metadata, source and bundle hashes,
`resolvedFrom` edges, and the target environment names that can consume each file.
`targetEnvironments` contains the exact Python patch version, OS, architecture, and
platform compatibility policy used during online selection. Offline publishing never
needs to open wheel archives.

`python-metadata-cache.json` stores Core Metadata keyed by source index, artifact URL,
and source hashes. `python-fetch-report.json` records per-environment totals, planned or
downloaded files, unsupported inputs, and resolution/download errors.
When the source index supplies an artifact size, incremental download can reuse a file
whose active seed-manifest identity and current size still match; an explicit bundle
verification remains the full-content integrity check.

For current `python-app` bundles, this manifest is also a compatibility view over
content-addressed wheel paths for the current publisher. The consumer-facing result is
the set of projects and wheels available from Gitea PyPI, not this manifest or
`python/application-index.json`.

## python-security-report.json

Records OSV results for each exact normalized PyPI `name==version` in the complete
`python-seed-manifest.json`. `manifestSha256` binds the report to that manifest.
Download activation, verification, PyPI publication, and Python application-evidence
publication require `ok: true`, an exact digest match, complete wheel SHA-256 values,
and a report within `policy.maxReportAgeHours`. `MAL-*` advisories and scanner failures
block the report; ordinary vulnerability advisories are warnings.
When `python/application-index.json` exists, every indexed application wheel must also
occur in this checked manifest with the same package identity, path, and SHA-256.

A rejected candidate is recorded in `python-security-report.failed.json` and does not
replace the active Python manifest. The report establishes that OSV had no known
malware record at scan time; it is not static analysis of wheel contents.

## python/application-index.json

Records every ready Python application collection plan and the shared artifacts it
references in the current format.
`selectionId` groups all resolved version variants produced by one workspace
application selection; versioned `targetId` identifies one concrete alternative.
Application entries point to:

- environment planning evidence and a human-readable plan diff;
- per-cell `pylock.toml` resolver evidence and an optional hash-complete
  `requirements.lock`;
- external CPython/system prerequisite report whose generation timestamp is inherited
  from the active plan, so repeated downloads do not change its content;
- optional reviewed health checks.

Artifacts are content-addressed by SHA-256. Every reference names exact compatibility
cells (platform family, Python minor, and Linux glibc floor where applicable), so one
universal or `abi3` wheel can cover several cells without being copied. The selected
set is the minimum practical byte cover of the dependency trees resolved for those
cells. CPython distributions and consumer package managers are not application-plan
artifacts. The summary reports application/artifact counts and total unique bytes.

An interrupted download may leave verified content-addressed files, but the index and
application document set are replaced only after the whole requested run succeeds.
Retry reuses those files. Partial target downloads replace every prior version variant
of the selected application group, merge references, and never remove objects belonging
to unselected applications.

Incremental `download` treats an artifact recorded by the active index as previously
verified when its path, identity, source URL, and current size still match. This avoids
rehashing an unchanged multi-gigabyte bundle on every update check. New files and files
not covered by the active index are always SHA-256 verified before use. Run
`airgap-sync verify` for an explicit full-content integrity check.

The application index schema is version 3. Schema-v1 and schema-v2 application bundles
must be downloaded once with the current version before publication; existing
content-addressed wheels are reused. Bundles containing the removed runtime-transfer
artifact kinds must likewise be refreshed before publication.

## python/distributions/index.json

Records the active rolling set selected by `cpython-distributions` targets. Each entry
contains the exact CPython version, provider build, publication time, platform,
variant, source URL, size, SHA-256, and content-addressed local path. Target references
determine which objects remain live when a successful full download prunes the bundle.

Selection is recomputed from provider metadata on every applicable download. Patch
depth is evaluated per platform, provider builds are retained according to the target's
day window, and the newest matching build is always included. Availability is
progressive: an artifact published for one platform is activated without waiting for
the other configured platforms.

The index is replaced atomically only after all selected files have been acquired and
verified. Partial target downloads merge their selected references with unselected
targets. `fetch-report.json` records selection and acquisition results;
`publish-report.json` records the latest closed-side publication attempt.

Closed-side publication uses additive Gitea Generic Package coordinates
`python-build-standalone/<provider-build>/<filename>`. Exact remote content is skipped,
conflicting content is rejected, and remote objects are never deleted. Publication
state is not an input to later collection or pruning.

## python/publications/\<publication-id\>/publication-manifest.json

Created during closed-network publish after Gitea authentication and owner resolution.
It records the normalized Gitea URL, resolved PyPI and optional Generic owners, source
plan IDs, source-document paths and digests, concrete package coordinates, and
materialized evidence-document paths and digests. CPython distribution publication is
reported separately under `python/distributions/` and is not part of an application
publication manifest.

`publicationId` is deterministic over the destination and exact transferable source
documents. Tokens, authenticated login, publication-run timestamps, and upload results
are excluded. Therefore a byte-identical application bundle can be retried
idempotently, changed evidence documents receive new immutable Generic Package
versions, and the same collected files can be uploaded to another Gitea deployment
without downloading the wheels again. Bundle completeness is established independently
of other packages already present at the destination. Generic Package objects are not
part of normal Python dependency resolution.

## Reports

Reports are operational logs. They are allowed to change between minor versions while
the project is pre-1.0. Consumers do not read bundle manifests directly; they use the
repositories populated during `publish`.

Unsupported specs in `fetch-report.json` include `requiredBy`, so Git, file, link, and
other non-registry specs can be traced back to the package that declared them.
The report also includes `timings` for registry resolution, tarball download,
package-manifest reading, dependency scanning, and total fetch time. Phase timings are
cumulative across parallel workers; `totalMs` is the wall-clock duration.

Git specs are also summarized separately in `gitRequirements`. Each item records the
declaring package, package alias/name when present, raw npm spec, hosted provider
metadata when npm can infer it, and the requested commitish/range/subdirectory. This is
the input for Git mirror workflows.

`git-sources.json`, when generated by `airgap-sync git sources --write`, is derived
from those requirements. It is portable source metadata and is not bound to a specific
Gitea instance. Source records preserve enough information to map mirrors without
flattening upstream identity:

- source URL;
- source host;
- upstream owner/repository path;
- requested commitish/range/subdirectory;
- local mirror path;
- `requiredBy` edges.

Offline commands derive Gitea targets from this file and the local `--gitea` URL. For
example, `https://github.com/antvis/G2.git` maps to
`http://gitea.local/antvis/G2.git`.

`git-fetch-report.json`, when generated by `airgap-sync git fetch`, records whether
each local mirror was cloned, updated, planned in dry-run mode, or failed. With
`git-sources.json`, bare mirror repositories are stored under preserved source paths in
`git-mirrors/` by default. Updated mirror actions also include `changed` when refs were
compared before and after fetch, `addedRefs`, `updatedRefs`, `deletedRefs`, and
`newCommits` when Git can count commits between the previous and fetched ref tips.

`collect-report.json`, when generated by `airgap-sync download`, records the combined
online orchestration result: npm and Python fetch, Git source metadata, and Git mirror fetch. In
lower-level directory collection it can also record repository refresh results. It
also records fixed-point iterations, including how many Git sources were scanned and
how many new npm/Git requirements were added by mirrored package manifests and
supported lockfiles. The
top-level `timings` object breaks collection time down by repository refresh, root
manifest scan, lockfile scan, npm fetch iterations, Git mirror fetch, Git manifest
scan, bundle document writes, and report writes.

`workspace-snapshot.json`, when generated by workspace-mode `airgap-sync download`,
records the configured Git/npm/Python application targets, coverage policies, and
Python settings that
produced the bundle. Git targets store
bundle-local mirror paths, for example `git-mirrors/github.com/acme/app.git`, so later
verification can check out the intended project from the self-contained transfer
bundle. Git, PyPI, and exact root-wheel targets also preserve an optional
`pythonResolutionMode` override; targets without it inherit the snapshot's top-level
workspace mode.

`prune-report.json`, when generated by `airgap-sync bundle prune` or
`airgap-sync download --prune`, records stale local bundle objects removed from
`packages/`, `python-packages/`, and `git-mirrors/`. Dry runs write
`prune-dry-run-report.json`. Pruning is
limited to the transfer bundle and does not remove anything from Verdaccio or Gitea.

Workspace `airgap-sync.json` may also contain operator convenience fields such as
`targetRegistry` and `giteaUrl`. They are used by the interactive menu and are not
required for the portable bundle itself.

`git-apply-report.json`, when generated by `airgap-sync git apply`, records branch/tag
mirror push results and includes generated `git config url.*.insteadOf` commands for
the closed network. Provider-specific refs such as GitHub pull-request refs are not
published to Gitea.

`gitea-repos-report.json`, when generated by `airgap-sync git create-repos`, records
whether Gitea organizations and repositories were created, already existed, planned in
dry-run mode, or failed.

`git-config-report.json`, when generated by `airgap-sync git config`, records whether
the closed-network `insteadOf` rules were planned, configured, or failed.

`apply-report.json`, when generated by `airgap-sync publish`, summarizes the closed-network
import: npm publish/dist-tag results, Gitea repository provisioning, Git mirror push
results, Python wheel publishing, optional evidence publication, the Python index
URL, and optional global Git config writes. Python details are also written to
`python-publish-report.json` and `python-application-publish-report.json` (or their
dry-run counterparts). Dry runs write `apply-dry-run-report.json`.

## Run History

The root reports and manifests describe the latest bundle state. Successful non-dry-run
`download` and `publish` commands also copy diagnostics into append-only run
directories under `runs/`.

`runs/download/<run-id>/` contains before/after copies of `seed-manifest.json` and
`dist-tags.json` when available, the operational reports from that download,
`package-changes.json`, and `resolution-changes.json`. `package-changes.json` compares
the before/after seed manifests and lists package versions added to or removed from the
bundle, including their `resolvedFrom` parents. `resolution-changes.json` summarizes
npm requirements that were newly mapped, changed to another version, or pruned from the
transfer bundle. It is derived from the before/after seed manifests, so it reflects all
fixed-point download iterations, not only the final `fetch-report.json`. These compact
reports are intended for answering questions such as "what changed in this update?"
without diffing large reports by hand.

`runs/publish/<run-id>/` contains the publish/apply reports produced by the closed
network import. These directories are safe to archive or delete when old diagnostics
are no longer useful; they are not used as input for later downloads or publishes.

`verify-report.json`, when generated by `airgap-sync verify`, records static bundle
checks and their `ok`, `warning`, or `error` status. It does not run package-manager
installs; install verification is a later workflow layer.

`verify-install-report.json`, when generated by `airgap-sync verify install`, records
real package-manager install checks for workspace Git targets, including selected
package manager, command, whether lifecycle scripts were skipped, temporary copy path,
exit code, and truncated stdout/stderr.
For each Python application, the verifier selects a locally matching planned cell,
serves only `python-seed-manifest.json` files through a temporary local Simple API, and
runs ordinary dependency-resolving installs with pip and uv in separate venvs. A
missing suitable interpreter or uv executable is a documented skip. Static bundle
verification checks dependency closure, metadata, hashes, exact cell references, and
wheel compatibility across every planned cell.

## Audit

Use `airgap-sync info ./airgap-bundle` to print a JSON summary of package counts,
tags, report status, missing tarball files, and validation issues before transferring
or publishing a bundle.

`airgap-sync npm publish` runs the same validation before it starts npm publish
commands.
