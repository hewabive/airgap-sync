# Python Repository Security Review

Date: 2026-08-05

This review covers collection of Python wheels and their publication to a Gitea PyPI
registry. The consumer boundary is the registry: standard Python clients resolve and
install packages from its Simple API without knowing about `airgap-sync`.

The initial compatibility envelope is CPython 3.10–3.13 on Windows x86-64 and glibc
Linux x86-64. Operating-system packages, drivers, interpreter provisioning, service
management, application data, and rollback are outside this review.

## Trust boundaries

| Input or action      | Boundary and control                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source indexes       | Use explicitly configured HTTPS package indexes. Record source identity and do not silently fall back to an additional public index.                                                                     |
| Project metadata     | Treat dependency metadata as untrusted input. Resolve only supported PEP 503/691 repository artifacts and validate names, versions, wheel tags, and `METADATA` identity.                                 |
| Wheels               | Accept wheels only, verify the source-provided hash when available, calculate SHA-256 during download, and store one content-addressed copy. Source distributions and consumer-side builds are rejected. |
| Collector resolver   | A pinned, hash-verified `uv` may be used as an internal collection tool. Its version is evidence about collection, not a required consumer version and not a reason to duplicate a package closure.      |
| Compatibility matrix | Target OS, architecture, Python minor, ABI, and glibc policy come from the declared coverage envelope, never from the collector host.                                                                    |
| Bundle closure       | Collect a complete recursive dependency tree down to leaves for each target and supported compatibility cell. Prove completeness against an index populated only from that bundle.                       |
| Shared Gitea owner   | Treat publication as additive. Independent airgap-sync workspaces and other trusted publishers may add packages; do not inventory or reconcile the owner as a whole.                                     |
| Credentials          | Read credentials from the environment/CLI or the separate workspace secret file. Never write tokens into manifests, package URLs, reports, or generated client configuration.                            |
| Recipes              | Treat recipes as reviewed optional policy for extras, known exclusions, and health checks. They may narrow or explain coverage but must not redefine the general package-repository contract.            |
| Health checks        | Run only during explicit verification in a temporary environment. A recipe health check is trusted executable policy and must be reviewed as code.                                                       |

## Security properties

- Publication does not execute wheels and does not require Python, pip, uv, or twine in
  the isolated network.
- Consumer commands use the intended Gitea index as their only package source. This
  prevents an incomplete local repository from being silently completed from the
  internet and limits dependency-confusion exposure.
- Every declared compatibility cell is accepted or rejected as a whole. A successful
  bundle must not contain an unreported partial platform closure.
- The bundle contains the minimum practical union of wheels needed for its targets to
  cover the declared matrix. Universal and compatible `abi3` wheels are shared by hash;
  platform-specific files are included only for cells that need them. Packages already
  present in Gitea are not used to make an otherwise incomplete bundle look complete.
- Downloads use temporary files, size/hash validation, and atomic activation.
  Interrupted runs may retain verified content-addressed objects, but they do not
  activate an incomplete repository manifest.
- Explicit bundle verification rehashes indexed artifacts after untrusted storage or
  transport.
- Publishing and retry behavior are idempotent for identical package files. A name and
  version conflict is not accepted merely because an object already exists; the exact
  coordinate must refer to identical content. Unrelated package coordinates are not a
  conflict and do not require whole-registry reconciliation.
- Locks may be retained as audit evidence or an optional stricter operator workflow,
  but the security and completeness claim does not rely on consumers downloading or
  following an `airgap-sync` lock.
- There is no requirement that pip, uv, Poetry, or PDM later choose the same dependency
  versions as the collector. The guarantee is availability of at least one complete
  compatible tree contributed by the bundle, not reproducibility of resolver output.

## Required acceptance checks

For every supported Python/platform cell, populate a temporary index only from the
collected bundle, create a clean environment whose only Python index is that temporary
index, and verify at least:

```bash
python -m pip install --only-binary=:all: APP
uv pip install --only-binary=:all: APP
```

The checks must allow normal dependency resolution. The built-in verifier serves the
bundle through a loopback-only Simple API, clears user pip/uv index configuration, and
uses fresh caches. Static verification checks every planned cell; CI and release
testing should execute the dynamic checks across the supported OS/Python matrix.

## Operator obligations

- Use HTTPS and normal certificate validation for production source and Gitea
  endpoints.
- Restrict the consumer configuration to the intended Gitea PyPI endpoint; avoid a
  public `extra-index-url` unless the loss of isolation is deliberate.
- Review custom recipes and health checks before collection or verification.
- Treat `airgap-sync.secrets.json` and the transfer medium as sensitive because saved
  credentials are plaintext.
- Provide a compatible CPython and system prerequisites through separate consumer
  infrastructure.
- Transfer model weights and other application data through a separate
  integrity-controlled workflow.

## Residual risks

- A compromised source index or maintainer can publish a malicious but correctly
  hashed wheel. Hashes protect integrity in transit and storage, not publisher trust.
- Python installation can execute package code. `airgap-sync` does not provide an
  operating-system sandbox for consumer installs or health checks.
- Metadata interpretation can differ between package-manager versions. Testing both
  pip and uv reduces this risk but cannot cover every future client release; the
  supported client/envelope policy must be versioned as the project matures.
- Gitea PyPI behavior and authentication policy depend on the deployed Gitea version
  and must be integration-tested against supported deployments.
- Additional packages published into a shared owner can change which compatible
  versions a resolver selects. This is accepted behavior, not a completeness failure;
  registry access control and publisher trust remain operator responsibilities.
- The built-in verifier constrains package indexes but does not create an
  operating-system network sandbox. Installer or health-check code can still initiate
  arbitrary network access unless the test host applies its own isolation.
