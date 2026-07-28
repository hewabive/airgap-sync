# Python Publication Destination Refactor Plan

## Status

Accepted for implementation on 2026-07-28.

This plan changes Python publication to follow the existing Git publication model:
the Gitea token identifies the actor, destinations are resolved on the closed-network
side, and missing destination organizations are provisioned before uploads start.

## Decisions

1. One Gitea token is used for Git, PyPI, and Generic Package publication.
2. New workspaces publish PyPI and Generic artifacts to one managed public
   `airgap-packages` organization by default.
3. Separate PyPI and Generic owners remain optional overrides.
4. Missing organizations are created automatically with the authenticated token.
5. Users are never created automatically. A user owner must be the authenticated user.
6. Gitea publication coordinates are removed from the Python application plan.
7. Concrete consumer URLs and Generic Package coordinates are materialized during
   closed-network publication.
8. Legacy raw Python seeding remains supported. Existing schema-v1 Python application
   bundles require a new download with the updated application-plan schema.

## Target model

The refactor separates three layers:

```text
Application plan
  application identity, platforms, dependency closure, hashes, runtime inputs
        |
        v
Publication profile
  Gitea owner strategies and public/private consumption policy
        |
        v
Publication manifest
  resolved owners, concrete URLs, package coordinates, document digests
```

Credentials are not part of any of these documents. The authenticated login and
timestamps belong to the publication report.

The proposed workspace shape is:

```json
{
  "python": {
    "publication": {
      "owner": {
        "strategy": "fixed-owner",
        "kind": "organization",
        "name": "airgap-packages"
      },
      "visibility": "public"
    }
  }
}
```

`pypiOwner` and `genericOwner` may override `owner`. Each owner uses one of:

- `authenticated-user`;
- `fixed-owner` with `kind: organization`;
- `fixed-owner` with `kind: user`.

A fixed user must match the login returned by `GET /api/v1/user`. A fixed
organization is provisioned if it is missing.

## Phase 1: General Gitea owner provisioning

Introduce reusable owner requirements carrying:

- owner name and kind;
- desired visibility;
- purposes (`git`, `pypi`, and/or `generic`).

Refactor the Git-specific organization creation path into a general provisioner.
Resolve Git and Python destinations first, collect all owner requirements, deduplicate
them, and provision every required organization once.

Extend the Gitea client with the read operations required to:

- get the authenticated login and server version;
- distinguish existing organizations and users;
- detect a user/organization namespace conflict;
- inspect organization visibility where the server exposes it.

Dry-run must report planned organization creation without making API calls. A failed
organization must block only dependent repositories or packages and must produce one
causal error instead of repeated upload failures.

## Phase 2: Destination-neutral application plans and bundles

Create a new Python environment-plan schema without:

- `publication.applicationArtifactOwner`;
- `publication.pythonPackageOwner`;
- Generic Package coordinates on runtime artifacts.

Publication settings must no longer contribute to `planId`. The same application
closure and transferable artifacts must have the same `planId` for every Gitea URL and
owner profile.

Split consumer generation into:

- destination-neutral requirements locks, generated during download;
- deployment-specific consumer configuration, generated during publish.

Create a new Python application-bundle index schema without concrete consumer contract
paths or publication-document digests. Pre-publication bundle verification validates
the plan, evidence, locks, prerequisite reports, artifact references, sizes, and hashes.

## Phase 3: Publication manifest and consumer materialization

Resolve the Python publication profile after authenticating to Gitea. Create a
deterministic publication manifest containing:

- normalized Gitea base URL;
- resolved PyPI and Generic owners;
- source application `planId` values;
- PyPI index URL;
- application Generic Package coordinates;
- shared runtime/tool Generic Package coordinates;
- materialized document paths and digests.

Compute `publicationId` from semantic destination data only. Exclude credentials,
authenticated login, timestamps, and upload results.

Write materialized output under:

```text
python/publications/<publicationId>/
  publication-manifest.json
  applications/<target-id>/
    consumer-contract.json
    pip.conf.template
    consumer.env.template
```

Application-document Generic versions include both plan and publication identity so
multiple deployment profiles can coexist under one owner. Shared runtime/tool
coordinates remain derived from artifact identity and the resolved Generic owner.

## Phase 4: Publication orchestration

Change `applyBundle` to:

1. read and validate the bundle;
2. authenticate and resolve Git and Python destinations;
3. perform Gitea version/package-registry preflight;
4. provision all required organizations;
5. provision Git repositories;
6. publish npm packages;
7. publish PyPI wheels;
8. materialize consumer documents;
9. publish Generic artifacts;
10. push Git mirrors and optionally configure Git rewrites;
11. write reports and run history.

`--skip-git-provision` continues to affect Git repositories only. It must not suppress
package-owner provisioning.

The existing `python-seed-manifest.json` remains destination-neutral and is published
to the resolved PyPI owner. `--python-owner` remains temporarily as a deprecated
one-run PyPI override.

## Phase 5: Workspace and bundle migration

Add an automatic workspace migration for the new publication profile.

The untouched defaults:

```json
{
  "publishOwner": "pypi",
  "applicationArtifactOwner": "python-apps"
}
```

map to the managed `airgap-packages` organization. Custom legacy values remain
readable but require an explicit owner kind before automatic provisioning; the
migration must not guess whether a custom name is a user or organization.

Schema-v1 active application plans become stale and are automatically replanned on the
next normal download. Content-addressed wheels and optional artifacts are reused by
hash. Publishing a schema-v1 application bundle fails once with an actionable request
to run a new download. Legacy non-application Python seed bundles remain supported.

## Test requirements

Unit and integration coverage must prove:

- a shared PyPI/Generic organization is created once;
- split organizations are created with the same token;
- existing organizations are reused;
- user owners are never created;
- a fixed user different from the authenticated login is rejected;
- owner provisioning happens before Python upload;
- provisioning failure blocks dependent uploads;
- dry-run performs no Gitea mutation;
- publication settings do not affect `planId`;
- publication settings do affect `publicationId`;
- credentials never enter plans, manifests, documents, URLs, or reports;
- materialization is deterministic and repeatable;
- publication retries verify and skip identical remote artifacts;
- old application bundles produce an actionable migration error;
- a fresh real Gitea instance needs only the administrator token: publication creates
  `airgap-packages`, uploads PyPI and Generic artifacts, and supports a closed-index
  install.

## Delivery sequence

1. Record this plan and add characterization tests.
2. Add reusable Gitea owner resolution and provisioning.
3. Add the workspace publication profile and migration.
4. Introduce destination-neutral plan and application-bundle schemas.
5. Add publication manifest and consumer materialization.
6. Reorder `applyBundle` and update both Python publishers.
7. Update CLI/menu/reporting.
8. Complete real-Gitea E2E, documentation, and full validation.

Each material phase is committed separately.

## Definition of done

Against a fresh supported Gitea instance, a bundle is published with one administrator
token and no pre-created users or organizations. `airgap-packages` is provisioned
automatically, Git publication continues to behave as before, PyPI and Generic
publication are idempotent, and the same Python application `planId` can be published
to another Gitea deployment without repeating dependency resolution or artifact
download.
