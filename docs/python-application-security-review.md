# Python Repository Security Review

Date: 2026-08-05

This review covers collection of Python wheels and their publication to an isolated
Gitea PyPI registry. The consumer boundary is the registry: standard Python clients
resolve and install packages from its Simple API without knowing about `airgap-sync`.

The initial compatibility envelope is CPython 3.10–3.13 on Windows x86-64 and glibc
Linux x86-64. Operating-system packages, drivers, interpreter provisioning, service
management, application data, and rollback are outside this review.

## Trust boundaries

| Input or action      | Boundary and control                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source indexes       | Use explicitly configured HTTPS package indexes. Record source identity and do not silently fall back to an additional public index.                                                                      |
| Project metadata     | Treat dependency metadata as untrusted input. Resolve only supported PEP 503/691 repository artifacts and validate names, versions, wheel tags, and `METADATA` identity.                                  |
| Wheels               | Accept wheels only, verify the source-provided hash when available, calculate SHA-256 during download, and store one content-addressed copy. Source distributions and consumer-side builds are rejected.  |
| Collector resolver   | A pinned, hash-verified `uv` may be used as an internal collection tool. Its version is evidence about collection, not a required consumer version and not a reason to duplicate a package closure.       |
| Compatibility matrix | Target OS, architecture, Python minor, ABI, and glibc policy come from the declared coverage envelope, never from the collector host.                                                                     |
| Final sparse index   | Resolve each supported environment against exactly the candidate set that will be published. Repeat collection and validation until every supported cell closes without reaching another index.           |
| Gitea destination    | Publish package files into a controlled owner/namespace. Validation must account for packages already visible to consumers, or publish into an isolated namespace whose contents match the validated set. |
| Credentials          | Read credentials from the environment/CLI or the separate workspace secret file. Never write tokens into manifests, package URLs, reports, or generated client configuration.                             |
| Recipes              | Treat recipes as reviewed optional policy for extras, known exclusions, and health checks. They may narrow or explain coverage but must not redefine the general package-repository contract.             |
| Health checks        | Run only during explicit verification in a temporary environment. A recipe health check is trusted executable policy and must be reviewed as code.                                                        |

## Security properties

- Publication does not execute wheels and does not require Python, pip, uv, or twine in
  the isolated network.
- Consumer commands use the intended Gitea index as their only package source. This
  prevents an incomplete local repository from being silently completed from the
  internet and limits dependency-confusion exposure.
- Every declared compatibility cell is accepted or rejected as a whole. A successful
  bundle must not contain an unreported partial platform closure.
- The published repository contains the minimum practical union of wheels needed to
  cover the declared matrix. Universal and compatible `abi3` wheels are shared by hash;
  platform-specific files are included only for cells that need them.
- Downloads use temporary files, size/hash validation, and atomic activation.
  Interrupted runs may retain verified content-addressed objects, but they do not
  activate an incomplete repository manifest.
- Explicit bundle verification rehashes indexed artifacts after untrusted storage or
  transport.
- Publishing and retry behavior are idempotent for identical package files. A name and
  version conflict is not accepted merely because an object already exists; the
  destination content or repository state must be verified.
- Locks may be retained as audit evidence or an optional stricter operator workflow,
  but the security and completeness claim does not rely on consumers downloading or
  following an `airgap-sync` lock.

## Required acceptance checks

For every supported Python/platform cell, create a clean environment whose only Python
index is the final Gitea repository and verify at least:

```bash
python -m pip install --only-binary=:all: APP
uv pip install --only-binary=:all: APP
```

The checks must allow normal dependency resolution. A successful
`--no-deps --require-hashes` install proves that one precomputed lock is internally
usable; it does not prove that the published repository is sufficient for arbitrary
standard clients.

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
- Existing code still verifies Python applications through generated locks and can
  collect `all-compatible` wheels. Until final-index resolution and minimum-cover
  selection are implemented, those checks do not satisfy the complete target contract
  in [Python Support](python.md).
