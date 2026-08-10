# Security Policy

## Security Model

airgap-sync is a local operator tool, not a sandbox. It downloads npm packages and
hash-verified Python wheels, clones Git repositories, publishes artifacts to explicitly
configured target registries, and can push Git mirrors into Gitea.

Downloaded npm tarballs are checked against registry SRI/SHA-1 metadata and recorded
with SHA-256 in a schema-v2 bundle manifest. Download activation fails closed when OSV
is unavailable, an exact version has a malware advisory, or static inspection finds a
non-registry dependency. Lifecycle scripts are recorded non-blocking findings because
many legitimate native and toolchain packages require them. A static acknowledgement
or exception is bound to the exact package name, version, and SHA-256. Ordinary
vulnerability advisories remain in the complete security report. Normal console output
shows neutral inventory totals and warns only about vulnerability or unapproved
lifecycle findings added since the previous successful scan. The first successful scan
creates a baseline; failed or incomplete scans never advance it or infer resolutions.

For unlocked SemVer ranges, the default `prefer-clean` resolution policy performs a
bounded OSV-aware preflight and selects a compatible release with no known findings
when available. It does not rewrite exact versions, dist-tags, or lockfile selections.
Every substitution records the parent, range, original version, selected version, and
advisory IDs in `fetch-report.json`. This is a best-effort known-vulnerability
optimization, not reachability analysis or proof that the selected code is benign.

Hashing and static manifest inspection share one streaming tarball read on a cache miss.
Download persists normalized embedded manifests by tarball SHA-256. Reuse requires the
previous schema-v2 seed manifest to identify the expected SHA-256, then re-hashes the
current file in full and checks both that digest and resolved registry SRI/SHA-1 before
using cached manifest data. File metadata alone is never accepted as cross-process
evidence. An explicit later verify or publish operation ignores the persistent cache and
fully reads, hashes, and parses the transferred archive again at that trust boundary.

`airgap-sync verify install` runs real package-manager commands for target projects.
It skips npm, pnpm, and Yarn lifecycle scripts by default. `--run-scripts` is an
explicit opt-in and executes untrusted package code without an operating-system
sandbox.

These controls reduce npm supply-chain exposure; they do not prove that package code
is benign. OSV may not yet know about a compromise, registry metadata can itself be
compromised, and malicious code can run later when an application imports the package.

Python application health checks run only during explicit install verification and
inside its temporary environment, but a workspace recipe remains trusted executable
policy. Review custom recipes before use. Python collection is wheels-only, verifies
artifact identity and hashes, and queries OSV for every exact normalized PyPI
`name==version`. A `MAL-*` advisory or OSV failure prevents candidate activation;
ordinary vulnerability advisories remain recorded non-blocking findings. Download
warns when one is new relative to the previous successful scan. Verify and every Python
publication path require a fresh passing report bound to the complete
`python-seed-manifest.json`. Indexed Python application wheels must be present in that
checked manifest with matching identities and hashes. There is no Python malware
allow-list.

These Python controls detect already catalogued malicious releases; they do not inspect
wheel code or prove that upstream code is benign. OSV may not yet know about a
compromise. Generated locks are optional evidence. Completeness means that each
collected target brings its recursive dependency tree down to leaves for every declared
compatibility cell. It is tested with ordinary clients against an index populated only
from that bundle; it does not require consumers to follow an `airgap-sync` lock or
require airgap-sync to control all packages in the shared Gitea owner. Consumer
configuration should still avoid unintended public-index fallback.

The tool is designed to avoid storing credentials in workspace config files. Pass
Gitea tokens through `GITEA_TOKEN` where possible; command-line token arguments
can be visible through shell history and process listings.

`airgap-sync publish` pushes Git mirrors with mirror semantics. Use it only against
Gitea repositories that are intended to be managed as mirrors of the source
repositories.

See the [Python repository security review](./docs/python-application-security-review.md)
for detailed trust boundaries, failure recovery, and residual risks.

## Supported Versions

This project is pre-1.0. Security fixes are applied to the latest released version.

## Reporting a Vulnerability

Open a private security advisory on GitHub or contact the repository owner through
GitHub if a private report is needed.

Do not publish exploit details until a fix or mitigation is available.
