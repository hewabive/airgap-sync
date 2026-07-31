# Python Application Security Review

Date: 2026-07-27

This review covers the application-first Python path. `airgap-sync` remains a
publish-only transfer tool; production environment creation, driver installation,
service management, and rollback are outside its authority.

## Trust boundaries

| Input or action          | Boundary and control                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PyPI metadata and wheels | HTTPS source index, wheels only, exact SHA-256 from the index, filename/metadata identity checks, and content-addressed storage                                                       |
| Planner executable       | Collector-native `uv` release is version-pinned and SHA-256 checked against the reviewed manifest; config discovery is disabled                                                       |
| Target platform          | Explicit coverage family and Python candidate; never inferred from the collector                                                                                                      |
| Runtime/tool transfer    | Optional only; source URL, size, SHA-256, license, target platform, and Generic Package coordinates are recorded                                                                      |
| Workspace recipe         | Workspace-local reviewed policy. Its normalized digest is part of the immutable plan, changes make the active plan stale, and expiry requires review                                  |
| Probe                    | Reads OS, architecture, libc/Python compatibility, and explicitly requested capabilities only; no hostname, user identity, serial number, network address, or automatic GPU inventory |
| Gitea credentials        | Read from the environment/CLI or the separately stored workspace secret; used in request headers and never written into plans, locks, URLs, or reports                                |
| Consumer commands        | Closed-index URL contains no credentials; exact locks require hashes, disable dependency resolution, and reject source distributions                                                  |
| Health checks            | Run only during explicit `verify install`, inside its temporary environment. Recipes are trusted executable policy and must use non-destructive checks                                |

## Failure and recovery properties

- A plan becomes active only after every requested platform branch resolves. There is
  no partial-ready state.
- Artifact downloads use a temporary file, hash and size validation, and atomic rename.
  A failed multi-artifact run does not replace the bundle index; retry reuses already
  verified content-addressed files.
- Incremental download uses the atomically activated content index plus file size as its
  verified-object cache. It fully hashes new or unindexed files; the explicit `verify`
  workflow rehashes every indexed artifact and should be used after untrusted storage
  or transport.
- Application document directories are prepared separately and atomically swapped.
- Gitea Generic Package publication is immutable. On retry, a conflict is accepted
  only after downloading the existing object and matching its SHA-256.
- Partial target updates preserve references owned by unselected application plans.
  Garbage collection deletes only artifacts with no live references and never runs
  after an incomplete download.

## Operator obligations

- Treat `airgap-sync.secrets.json` and the removable medium as sensitive because saved
  tokens are plaintext.
- Review custom recipes and especially their health checks before planning or
  verification.
- Use HTTPS and normal certificate validation for production source and Gitea
  endpoints.
- Provision compatible Python and system prerequisites through the consumer
  infrastructure. Do not execute transferred runtime archives merely because they are
  present.
- Transfer model weights and configuration through a separate integrity-controlled
  application-data workflow.

## Residual risks

- A trusted health check can execute arbitrary Python in the temporary verifier.
- A compromised public index can publish malicious but correctly hashed wheels.
  Hashes provide integrity and repeatability, not publisher trust.
- The verification command does not create an operating-system network-deny sandbox.
  Closed-index configuration prevents package-manager fallback, but package import code
  can still use whatever network access the host permits.
- Gitea PyPI support and authentication policy are deployment-specific and must be
  tested against the deployed Gitea version.
