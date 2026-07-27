# Python Support Artifacts

`uv-tool-manifest.json` pins the standalone resolver executable used by the
application-first Python planner.

`runtime-catalog.json` pins optional CPython archives for the initial Windows and
glibc-Linux x86-64 platform families. These archives are transfer artifacts only:
`airgap-sync` records their hashes and generic-package coordinates but does not install
or manage Python on consumer machines.

The manifest distinguishes the collector tool platform from target platform families.
Every asset is downloaded only from its pinned HTTPS URL and accepted only after its
size and SHA-256 match.

`uv` is distributed under `Apache-2.0 OR MIT`. License URLs and hashes are pinned in
the manifest. Any bundle that redistributes a `uv` executable must include the
downloaded, hash-verified license text beside it.

`probe-linux.sh` and `probe-windows.ps1` are optional standalone diagnostics for
machines without Node.js. They emit only the OS family, architecture, libc
family/version where applicable, and an installed Python version when one is found.
They do not collect host identity, network addresses, serial numbers, or hardware
inventory. Running them is never a prerequisite for planning.

Copy the emitted JSON back to a machine with `airgap-sync` and compare it without
retaining any host inventory:

```text
airgap-sync probe --compare environment-plan.json --facts probe-facts.json
```
