# Python Support

This document defines the intended Python product contract. It is the canonical source
for Python scope, coverage, collection, publication, and consumer behavior.

The normal application path implements this contract. Plans and resolver locks remain
internal evidence. CPython distribution transfer is an independent target and does not
define normal application repository coverage.

## Goal

`airgap-sync` populates a Gitea PyPI registry with the smallest practical set of Python
artifacts needed to install selected applications throughout a bounded compatibility
range.

After publication, a consumer only needs the Gitea PyPI Simple API URL and a standard
Python package client. The normal consumer experience is ordinary package installation:

```bash
python -m pip install --index-url http://gitea.local/api/packages/airgap-packages/pypi/simple APP
uv pip install --default-index http://gitea.local/api/packages/airgap-packages/pypi/simple APP
```

`APP` denotes the requirement selected by the operator, including a version specifier
or extras when those are part of the target.

Poetry, PDM, and other clients are in scope when they consume the same standards-based
Python package index. They do not need to know how `airgap-sync` produced its contents.

Generated locks may remain useful for audit, diagnostics, or an operator who explicitly
wants a frozen installation. They are not the normal consumer interface and are not
required for bundle completeness.

## Compatibility Envelope

A finite minimal bundle is possible only for a bounded compatibility envelope. The
initial maximum envelope is:

- CPython 3.10, 3.11, 3.12, and 3.13;
- Windows x86-64;
- glibc-based Linux x86-64;
- wheels published through a PEP 503/691-compatible index;
- application extras and artifact-changing features explicitly selected by the
  operator.

The envelope describes classes of consumers, not an inventory of physical machines.
For example, “mainstream Ubuntu desktops on x86-64” can map to Linux/glibc x86-64 and a
documented minimum glibc version without collecting host identity.

The envelope must never silently expand. Adding another Python minor, architecture,
operating-system family, libc family, application extra, or accelerator-specific
artifact source can materially increase bundle size and must be visible in the plan.

Explicit package assignments can use additional public Simple API indexes (HTML or
JSON) without changing the Gitea PyPI consumer contract. Future support may add ARM64,
musl, macOS, more Python versions, and authenticated private sources.

## Guarantee Boundary

For every environment class declared supported by a completed target collection,
`airgap-sync` must bring the application and its recursive Python dependency tree down
to the leaves, so a standards-compliant client can resolve and install it from Gitea
without public-network access.

The guarantee does not cover:

- machines outside the declared compatibility envelope;
- conda, apt, Docker, or other non-PyPI distribution systems;
- source builds when no compatible wheel exists;
- system libraries, GPU drivers, kernels, services, or model weights;
- extras or application feature variants that were not selected;
- arbitrary installer bugs or clients too old to understand the required Python
  packaging standards.

System prerequisites may be reported for operators, but they are not Python dependency
artifacts and do not belong in the Python bundle.

## Application Targets

The normal input is a `python-app` target containing:

- the application package and version selection;
- optional overrides for the workspace compatibility envelope and Python runtime matrix;
- selected extras;
- explicit artifact-changing features;
- optional reviewed application policy.

`python.applicationDefaults.coverage` and `python.applicationDefaults.runtime` define
the effective envelope when a target omits `coverage` and `python`. Target fields replace
their corresponding default independently; lists are not merged. Changing a shared
default invalidates planning evidence for inheriting targets, while explicit overrides
remain unchanged. Python minors in the effective runtime envelope are candidates.
Project metadata such as `Requires-Python`, recipe policy, dependency resolution, and
wheel availability may narrow them, with every omission recorded in the plan and final
download report.

Planning prints the application version and Python/platform candidate being checked,
with a status message every 15 seconds while resolution is running. If newer candidate
versions are rejected or requested Python minors are omitted, both `plan` and `download`
print warnings and the path to the saved environment plan. Its
`presentation.rejectedCandidateSummaries` preserves resolver stderr, including the
specific dependency conflict or missing wheel; terminal warnings show a bounded summary.

Each normal download refreshes `latest-compatible` selectors (including constrained
selectors) against the source index. Exact selectors reuse current plans. A dry run
uses existing planning evidence and does not check for newer releases.

### Additional package sources and prerelease dependencies

For supported public applications, maintained source profiles are applied automatically.
Currently, a plain `sglang` target using PyPI receives the NVIDIA package assignments
and scoped prerelease policy from `support/python/sources/sglang.json`. This applies to
existing workspaces as well as newly added targets, without copying configuration.
The CLI announces the maintained profile and its sources during planning.

```json
{
  "type": "python-app",
  "spec": "sglang",
  "application": { "extras": [], "features": {} }
}
```

With no version constraint, this target checks the latest compatible stable SGLang
release on every download. A maintained source profile contains no application version
pin and does not change Python versions, platform coverage, or glibc requirements.
Changes to the maintained policy invalidate old plans automatically. If upstream adds
new source requirements outside the maintained profile, the profile needs an airgap-sync
update; normal incompatibility warnings still report any fallback.

An explicit target `resolution` takes precedence over `python.resolution`, which takes
precedence over the maintained profile. Policies replace one another as a whole. Use
`resolution: {}` to disable the maintained profile. A custom primary index does not
implicitly enable additional public sources; its source policy must be explicit. These settings are part of the planning intent, so a change
invalidates existing plans. They do not change npm resolution or publication settings.

```json
{
  "resolution": {
    "prereleasePackages": ["cuda-tile", "flash-attn-4"],
    "packageIndexes": [
      {
        "indexUrl": "https://pypi.nvidia.com/",
        "packages": ["cuda-tile"],
        "missingUploadTime": "allow"
      }
    ]
  }
}
```

Each package is read only from its assigned index, including when that index has no
matching version. Unassigned packages use `python.sourceIndex`. Assignments use exact,
normalized package names; overlapping assignments are rejected. No arbitrary build
backend is executed to discover additional sources. For example, a PyPI `wheel-stub`
archive can refer to a vendor index, but that index must be declared in the maintained
profile or in explicit resolution settings.

`prereleasePackages` allows prerelease dependency wheels only for named packages;
other packages are restricted to stable releases. Alternatively, `prerelease` can be
`allow`, `disallow`, or uv's `if-necessary-or-explicit`. The two settings cannot be used
together. Without either, uv's default applies. This policy does not enable prerelease
application candidates. A globally allowed prerelease policy can also select preview
versions of otherwise ordinary dependencies.

When package assignments or a scoped prerelease policy are present, uv and the wheel
enumerator share a lazily captured, immutable project view through a temporary
loopback index. Files with upload dates after the planning cutoff are excluded.
Files without upload dates are excluded unless their assigned index explicitly uses
`missingUploadTime: "allow"`. This permits artifacts observed now; it does **not**
claim that they existed at a historical cutoff. Invalid dates and yanked files are
excluded. The workspace plan directory also receives `source-snapshot.json` with
source URLs, observation times, hashes and eligible project files. Plans and bundle
manifests retain original artifact URLs and hashes, never the loopback file URLs.

Source settings inherited from the collector's uv/pip environment cannot add another
index or override the configured prerelease/cutoff policy. Source network failures
abort planning rather than being treated as package incompatibility.

The [SGLang example](../support/python/examples/sglang-0.5.19-py312.json) provides a
complete workspace pinned to SGLang 0.5.19 for reproducible verification on Python
3.12, Linux x86-64 and glibc 2.39. It uses the automatic source profile for the CUDA 13
dependency family. For automatic application updates, omit its exact version selector
or use `latest-compatible`. Copy it to
an isolated directory as `airgap-sync.json`, then run `plan .` and `download --target 1`
from that directory. CUDA drivers, GPU hardware and model files are separate runtime
requirements; selecting this profile is not a claim of GPU compatibility.

After building the CLI, verify wheel integrity and a fresh installation using only
local artifacts (an appropriate Python interpreter and uv must already be installed):

```sh
UV_BIN=/path/to/uv node scripts/verify-python-offline.mjs /path/to/airgap-bundle 'sglang==0.5.19' 3.12
```

The script uses `uv --offline`, disables source builds and remote indexes, installs
into a temporary environment, runs `uv pip check`, emits a JSON result, and removes
the environment. Allow disk space for the uncompressed installation in addition to
the wheel bundle. It does not launch SGLang or test a GPU.

Recipe `compatibility.applicationVersions` scopes the versions to which the recipe
applies; it does not pin the target. Versions outside that scope use the generic
planner without the recipe's extras, compatibility rules, prerequisites, or health
checks. Explicitly selected recipe features require a recipe covering the candidate
version; unsupported candidates are rejected with a reason. To pin an application,
use an exact target version selector.

An application-specific recipe may describe package-index choices, required extras,
known incompatibilities, and diagnostic metadata. Recipes are policy adapters, not
installers. The generic planner must remain useful for applications without recipes.

Complex applications are validation cases, not special architecture. Features such as
CPU, CUDA, or ROCm matter only when they change which Python artifacts and indexes must
be collected. Driver installation remains outside `airgap-sync`.

## Dependency Closure And Target Lifecycle

Python follows the same transfer model as npm. For each application target, the
collector evaluates every candidate Python minor. A minor is retained only when one
complete recursive dependency tree exists on every requested platform, and every wheel
required by those trees is transferred. Incompatible minors are reported and skipped;
failure to retain any minor rejects the target. A successful bundle has no missing
dependency edge in any retained cell and needs no source index after transfer.

The collector may use a pinned resolver version to choose that tree. The pin is an
implementation and tool-integrity detail: it is not a required consumer version, does
not define a matrix of consumer `uv` releases, and does not promise that another
resolver will choose the same versions.

An application target is transfer intent, not permanent memory of Gitea. A typical
one-time workflow is:

1. add the application target;
2. download its complete Python tree;
3. publish it to Gitea;
4. remove the target when updates are no longer wanted;
5. prune locally unreferenced bundle artifacts on a later full download.

Removing or pruning a target affects only the transfer workspace and removable-media
bundle. Packages already published to Gitea remain there. Parent references are needed
only to decide which local artifacts are still required by other active targets.

## No Reproducibility Requirement

`airgap-sync` does not guarantee or control the exact dependency graph selected later
by pip, uv, Poetry, PDM, or another client. In particular, it does not:

- require consumers to use the collector's resolver or lock;
- require an exclusive or empty Gitea owner;
- inventory all packages already present in Gitea;
- coordinate independent `airgap-sync` workspaces that publish to the same owner;
- reconcile or delete older published versions;
- promise that two installations performed at different times select identical
  versions.

The guarantee is availability: every bundle contributed by `airgap-sync` contains a
complete installable tree for its own targets and retained compatibility cells.
Additional packages published by another process are an allowed additive extension of
the shared registry. Deletion, replacement, or corruption of previously published
artifacts is outside this guarantee.

## Artifact Selection And Size

Only compatible wheels are collected in the normal path. Source distributions and
automatic PEP 517 builds remain excluded; an absent wheel rejects that Python minor. If
no minor remains, it is a target coverage failure or a request for an explicitly
supplied, reviewed wheel.

The desired artifact set is the smallest set that both covers every retained cell in
the compatibility envelope and contains the complete dependency trees selected
for the active targets. This is not the same as downloading every compatible wheel:

- universal and `abi3` wheels should be reused across environment cells;
- platform- and CPython-specific wheels are included only where needed;
- identical content is stored once and referenced by every application that needs it;
- alternate builds that add no compatibility coverage should not increase the bundle;
- total and incremental bytes must be reported before transfer.

Package versions can differ between environment classes when markers or wheel
availability require it. Multiple active targets contribute a union of their trees;
content-identical wheels are stored once and remain locally live while any target
references them.

## Gitea Publication

Gitea PyPI is the normal and sufficient consumer-facing publication surface. Publishing
must preserve standard package metadata including names, versions, `Requires-Python`,
`Requires-Dist`, extras, wheel filenames, and hashes.

Plans, reports, provenance, and optional operational artifacts may be published through
Gitea Generic Packages, but successful installation must not depend on a consumer
understanding an `airgap-sync`-specific document.

Publication is additive. Multiple independent `airgap-sync` workspaces and other
publishers may populate the same owner. `airgap-sync` verifies conflicts for the exact
files it uploads but does not otherwise control or remember registry contents. Pruning
the removable-media bundle never removes packages from Gitea.

## Python Runtimes And Package Managers

Transferring CPython or a package-manager executable is a separate concern from
populating a Python package repository.

The normal Python application target does not ask for consumer `uv` versions and does
not duplicate package closures for different `uv` releases. Managed CPython uses the
explicit `cpython-distributions` target. Consumer package-manager executables such as
`uv` are ordinary Python applications when they need to be transferred.

Consumers may use a compatible Python already present on the machine or a runtime
provisioned by other infrastructure. Runtime availability is not inferred from the
collector machine.

## Verification

The primary acceptance test is an unlocked install from a clean temporary index
containing only the bundle's Python artifacts. This proves that the bundle itself has a
complete tree for every supported environment class. At minimum, representative `pip`
and `uv` clients must be tested with only that index configured:

```bash
python -m pip install --index-url GITEA_SIMPLE_URL APP
uv pip install --default-index GITEA_SIMPLE_URL APP
```

Verification must check that:

- dependency resolution performs no public-network access;
- every selected artifact is a compatible wheel;
- the installation completes and package metadata is consistent;
- the installed environment passes the package manager's dependency check;
- optional application health checks run only when explicitly configured.

Exact lock installation remains a useful additional test, not a substitute for testing
normal repository resolution.

## Implemented Boundary And Remaining Work

The application path now:

- expands an unspecified Python selection to candidate CPython minors 3.10–3.13;
- retains each Python minor that resolves on every requested platform with the
  collector's pinned `uv`, while recording incompatible minors as skipped;
- keeps a minimum practical wheel cover for the resulting trees and deduplicates files
  by content;
- records exact cell references and checks dependency closure and wheel compatibility
  statically;
- verifies ordinary unlocked installs with both pip and uv against a temporary Simple
  API containing only bundle files;
- publishes wheels additively to Gitea PyPI, with Generic evidence disabled by default;
- prunes inactive workspace plans and locally unreferenced bundle artifacts after a
  successful full pruned download.

Raw PyPI, exact-wheel, repository requirements, and repository lockfile seeding have
been removed. If Python converters, GUIs, benchmark tools, or test tools from a Git
repository need offline support, they require an explicit application-level design and
recipe rather than automatic repository scanning. The former `python-runtime` target,
`python.artifactTransfer`, and application-plan runtime/tool artifacts are also gone.
`cpython-distributions`
selects stable Python minors, patches, platforms, and provider builds independently and
publishes them additively to Gitea Generic Packages. Broader indexes/platforms and a
full multi-platform Gitea integration matrix remain future work.
