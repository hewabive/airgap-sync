# Python Support Artifacts

`uv-tool-manifest.json` pins the standalone resolver executable used by the
application-first Python planner.

The manifest distinguishes the collector tool platform from target platform families.
Every asset is downloaded only from its pinned HTTPS URL and accepted only after its
size and SHA-256 match.

`uv` is distributed under `Apache-2.0 OR MIT`. License URLs and hashes are pinned in
the manifest. Any bundle that redistributes a `uv` executable must include the
downloaded, hash-verified license text beside it.
