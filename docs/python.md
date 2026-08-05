# Python Support

This document defines the intended Python product contract. It is the canonical source
for Python scope, coverage, collection, publication, and consumer behavior.

The implementation is being migrated to this contract. Existing bundle fields and CLI
commands that expose immutable plans, generated locks, or managed CPython artifacts are
transitional unless this document explicitly retains them.

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
required for repository correctness.

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

Future support may add ARM64, musl, macOS, more Python versions, private indexes, and
additional artifact sources without changing the Gitea PyPI consumer contract.

## Guarantee Boundary

For every environment class declared supported by a completed plan, `airgap-sync` must
publish enough Python artifacts for a standards-compliant client to resolve and install
the selected application from Gitea without public-network access.

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
- a named or inline compatibility envelope;
- selected extras;
- explicit artifact-changing features;
- optional reviewed application policy.

An application-specific recipe may describe package-index choices, required extras,
known incompatibilities, and diagnostic metadata. Recipes are policy adapters, not
installers. The generic planner must remain useful for applications without recipes.

Complex applications are validation cases, not special architecture. Features such as
CPU, CUDA, or ROCm matter only when they change which Python artifacts and indexes must
be collected. Driver installation remains outside `airgap-sync`.

## Resolution And Repository Closure

The collector may use a pinned resolver version to discover candidate package versions
for each environment class. That resolver is an implementation detail of the online
collection process; it is not a required consumer version and does not define a matrix
of consumer `uv` releases.

Planning must distinguish two graphs:

1. the candidate graph resolved against the source indexes;
2. the graph ordinary clients can resolve against the exact artifact set that will be
   visible in Gitea.

The second graph is the product contract. Before a bundle is considered complete, its
planned repository contents must be tested as a closed index for every environment
class. If resolving against that closed index selects another valid candidate or
exposes a missing dependency, collection must extend or constrain the repository and
repeat until it reaches a fixed point.

The state already present in the destination Gitea can affect resolution. The final
design must therefore either account for that state or publish into an isolated,
well-defined repository namespace or channel. Local bundle pruning alone is not a
destination retention policy.

## Artifact Selection And Size

Only compatible wheels are collected in the normal path. Source distributions and
automatic PEP 517 builds remain excluded; an absent wheel is a coverage failure or a
request for an explicitly supplied, reviewed wheel.

The desired artifact set is the smallest set that covers every cell in the declared
compatibility envelope and remains resolvable from the final Gitea index. This is not
the same as downloading every compatible wheel:

- universal and `abi3` wheels should be reused across environment cells;
- platform- and CPython-specific wheels are included only where needed;
- identical content is stored once and referenced by every application that needs it;
- alternate builds that add no compatibility coverage should not increase the bundle;
- total and incremental bytes must be reported before transfer.

Package versions can differ between environment classes when markers or wheel
availability require it. The union published to Gitea must still be closed under normal
consumer resolution.

## Gitea Publication

Gitea PyPI is the normal and sufficient consumer-facing publication surface. Publishing
must preserve standard package metadata including names, versions, `Requires-Python`,
`Requires-Dist`, extras, wheel filenames, and hashes.

Plans, reports, provenance, and optional operational artifacts may be published through
Gitea Generic Packages, but successful installation must not depend on a consumer
understanding an `airgap-sync`-specific document.

Publication is additive unless an explicit destination lifecycle policy says otherwise.
The tool must not assume that pruning the removable-media bundle removes old candidates
from Gitea.

## Python Runtimes And Package Managers

Transferring CPython or a package-manager executable is a separate concern from
populating a Python package repository.

The normal Python application target does not ask for consumer `uv` versions and does
not duplicate package closures for different `uv` releases. If managed CPython transfer
is retained, it should become an explicit target or independently configurable transfer
feature with its own compatibility and size reporting.

Consumers may use a compatible Python already present on the machine or a runtime
provisioned by other infrastructure. Runtime availability is not inferred from the
collector machine.

## Verification

The primary acceptance test is an unlocked install from the final closed index for every
supported environment class. At minimum, representative `pip` and `uv` clients must be
tested with only the Gitea index configured:

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

## Current Transition

The repository already implements platform-aware resolution, wheel validation,
content-addressed storage, Gitea PyPI publication, reports, and optional runtime
artifacts. The following behaviors are transitional and must not be treated as the
long-term product contract:

- generated lock files as the required consumer path;
- `--no-deps --require-hashes` as the only verified installation;
- one automatically selected CPython minor when consumers use unknown existing
  interpreters;
- `all-compatible` wheel collection instead of minimum coverage;
- `python.artifactTransfer.uvVersions` as an application setting;
- CPython transfer enabled by default;
- verification only against a generated lock rather than against the final sparse
  Gitea index.

Legacy raw PyPI, exact-wheel, runtime, requirements, and lockfile inputs remain readable
during migration. They must stay clearly separated from the normal application flow.

## Delivery Order

1. Make this repository contract and its acceptance tests authoritative.
2. Verify plain `pip` and `uv` installation from a temporary closed index.
3. Model the complete CPython 3.10–3.13 × Windows/Linux x86-64 envelope.
4. Resolve and validate the final sparse-index closure to a fixed point.
5. Replace `all-compatible` collection with minimum wheel coverage.
6. Separate optional runtime/tool transfer from application targets.
7. Define destination namespace and retention behavior.
8. Expand platforms and sources only after the initial envelope is stable.
