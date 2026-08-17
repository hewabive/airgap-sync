# 0013: Use Gitea Migration for Initial Git Import

Date: 2026-08-17

## Status

Accepted and implemented.

## Context

An ordinary Git push updates each advertised branch or tag through Gitea's receive
pipeline. Repositories with thousands of refs can therefore spend most of their first
publication running per-ref hooks even when object transfer itself is fast. A real
`llama.cpp` bundle mirror had 7,799 branch/tag refs and took about 15 minutes to push
into an empty local Gitea repository.

The removable bundle already contains a complete bare mirror. The missing operation is
an efficient way for Gitea to initialize a repository from that mirror without making
the bundle a permanent network service or turning the destination into a scheduled
pull mirror.

## Decision

For a missing repository during top-level `publish`:

1. Start a short-lived smart-HTTP server over the exact bundle mirrors. Bind to
   loopback by default, require per-run random Basic credentials, use opaque routes,
   permit only upload-pack discovery and upload-pack POST, advertise only
   `refs/heads/*` and `refs/tags/*`, and cap request/header/error buffers.
2. Call Gitea `POST /api/v1/repos/migrate` with `service: git`, `mirror: false`, and all
   issue/wiki/release/LFS migration features disabled. Gitea clones the Git object and
   ref database while `airgap-sync` retains responsibility for all non-Git data.
3. Close the temporary server immediately after repository provisioning.
4. Run the normal prune-aware branch/tag push. It verifies the import and remains the
   only update mechanism for repositories that already exist.
5. If the migration endpoint, source allowlist, or network path is unavailable, record
   `migrationError`, create an empty repository when necessary, and continue through
   the established push path.

Repository existence checks, migrations, and pushes use a shared bounded concurrency
setting. Results retain manifest order; progress and fallback details are reported as
operations complete. The default is two workers to improve throughput without
unbounded object packing, disk I/O, or Gitea database load.

Gitea must explicitly permit the temporary source through its migration allowlist. The
default application endpoint is loopback and requires both `ALLOWED_DOMAINS = localhost`
and `ALLOW_LOCALNETWORKS = true`. Remote/container deployments must select and allow an
address reachable from Gitea and protect the HTTP transport inside a trusted network or
tunnel.

## Consequences

- Initial publication cost follows one server-side clone instead of thousands of
  receive-hook executions. In the real `llama.cpp` test, import completed in about 23
  seconds and the verification push in about 0.2 seconds.
- The Gitea repository is normal, not a continuously synchronized mirror. Airgap
  boundaries and update timing remain controlled by explicit bundle publication.
- Existing repositories preserve the mature push behavior, including branch/tag prune.
- An administrator must opt into the narrowly scoped Gitea migration source policy.
- A failed optimization does not make publication unavailable, but its fallback is
  visible in the run report and may retain the original slower first-push behavior.
