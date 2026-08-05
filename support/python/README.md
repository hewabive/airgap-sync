# Python Support Artifacts

This directory contains checked-in implementation inputs for Python collection. The
consumer contract is documented in [`docs/python.md`](../../docs/python.md): consumers
use standard package managers against Gitea PyPI and do not read files from this
directory.

## Collector tool

`uv-tool-manifest.json` pins the standalone `uv` executable currently used by the
collector-side planner. The asset is downloaded only from its pinned HTTPS URL and is
accepted only after its size and SHA-256 match. Its version is an internal
implementation choice; it does not select or constrain the consumer's pip, uv, Poetry,
or PDM version.

Versioned `uv-tool-manifest-*.json` files currently also describe optional consumer
binaries. This is transitional. Package repository coverage must not be duplicated for
different consumer `uv` versions, and package-manager binary transfer should be modeled
separately if it remains supported.

`uv` is distributed under `Apache-2.0 OR MIT`. License URLs and hashes are pinned in
the manifest. A bundle that redistributes a `uv` executable must include the downloaded,
hash-verified license text beside it.

## Runtime catalogs

`runtime-catalog*.json` pins optional CPython archives for Windows x86-64 and glibc
Linux x86-64. The current catalog names retain associations with reviewed `uv` releases
because that is what the implementation consumes today; this association is not a
Python dependency-resolution requirement.

These archives are transfer artifacts only. `airgap-sync` does not install or manage
Python on consumer machines. Managed CPython may become its own target type; until that
decision is made, runtime catalogs and default runtime transfer are transitional and
must stay separate from the claim that a Gitea PyPI repository covers CPython
3.10–3.13.

## Probes

`probe-linux.sh` and `probe-windows.ps1` are optional diagnostics for machines without
Node.js. They emit only the OS family, architecture, libc family/version where
applicable, and an installed Python version when one is found. They do not collect host
identity, network addresses, serial numbers, GPU details, or other hardware inventory.
Running them is never a prerequisite for declaring repository coverage.

Current builds can compare emitted facts with planning evidence:

```text
airgap-sync probe --compare environment-plan.json --facts probe-facts.json
```

## Recipes

`recipes/` contains reviewed, application-specific policy that is copied into new
schema-v2 workspaces. A recipe may select extras, document a known unsupported branch,
or define an optional health check. Recipes supplement the generic collector; they are
not installers and must not be required for an otherwise ordinary PyPI application.

The current implementation includes recipe digests in planning evidence and considers
that evidence stale after a workspace-local edit or expiry. See
[`recipes/README.md`](recipes/README.md).

## Current bundle records

Current application planning writes evidence under `.airgap-sync/python-plans/`, and
`download` writes `python/application-index.json`, content-addressed wheels under
`python/artifacts/wheels/<sha256>/`, per-platform `pylock.toml`, and generated locks.
The existing publisher also materializes consumer templates and may publish evidence
or runtime artifacts to Gitea Generic Packages.

These records support migration and auditing, but they are not the intended consumer
interface. The target implementation publishes a minimum wheel set to Gitea PyPI and
validates normal dependency-resolving pip and uv installs against an index populated
only from that bundle. Plans, locks, templates, and optional runtime archives may
change format or move to a separate target without changing how consumers install
applications.
