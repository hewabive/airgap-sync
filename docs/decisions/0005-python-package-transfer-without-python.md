# 0005: Python Package Transfer Without A Python Runtime

Date: 2026-07-06

## Status

Accepted

## Context

Closed networks need Python packages in addition to Git repositories and npm packages.
Two environment facts shape the design:

- Machines that run `airgap-sync` — the online collector and the offline publisher —
  cannot be assumed to have Python, pip, or twine installed.
- The install target platform (operating system, CPU architecture, Python version)
  generally differs from the machine that runs `airgap-sync`, so "download what pip
  would install here" is wrong even where pip exists.

Python dependency semantics differ from npm in two ways that matter for collection:

- A Python environment holds exactly one version of each package. pip performs
  backtracking resolution at install time, so a naive "highest satisfying version"
  closure can miss versions pip would fall back to.
- One `name@version` ships as multiple files: platform-specific wheels plus an sdist.
  Correct file selection depends on the target environment, not on the collector
  machine.

## Decision

1. Python support is implemented natively in TypeScript over HTTP. `airgap-sync` never
   invokes `python`, `pip`, or `twine` for collection or publishing.
2. The closed-network registry is Gitea's built-in PyPI package registry. The minimum
   supported Gitea version is 1.26.2, the version exercised by the end-to-end test,
   rather than an untested broad version range.
   Publish uses the PyPI legacy upload API: multipart POST to
   `{giteaUrl}/api/packages/{owner}/pypi` authenticated with the existing Gitea token.
   All packages are published under one configured public owner so consumers use a
   single index URL without credentials. Upload authentication uses HTTP Basic with the
   current Gitea login and the existing token. Before upload, compact Simple Index
   metadata is queried in parallel and an exact version/filename/SHA-256 match is
   skipped. A 409 Conflict refreshes that metadata and is treated as already published
   only after the target file's SHA-256 matches the bundle.
3. Resolution is lockfile-first:
   - Lockfiles are authoritative. `uv.lock` and standardized `pylock.toml` graphs are
     filtered for each target environment and downloaded without re-resolving their
     dependency versions.
   - An uncovered `requirements.txt` entry or direct PyPI target is rejected by
     default, including exact pins, because dependency metadata alone is not a lock.
     Requirements beside a supported lockfile are treated as covered by that lock.
   - Operators can explicitly opt in to approximate resolution. In that mode,
     requirements and direct PyPI targets use a simplified closure: choose
     the highest version satisfying each PEP 440 specifier, read `Requires-Dist` from
     wheel core metadata, evaluate environment markers against the configured target
     environments, and recurse. No backtracking. The fetch report marks these results
     as approximate; install verification is the safety net. Other entries in a
     requirements input provide constraints, and `--hash` values constrain acceptable
     files.
   - The workspace mode is the default. Git, PyPI, and exact root-wheel targets can
     override it independently, while `--allow-approximate-python` remains a run-wide
     override with highest priority.
4. Target environments are explicit configuration: a list of (full Python version,
   OS, architecture, libc/manylinux level) entries. Dependency resolution and wheel
   selection run independently for every configured environment and their results are
   unioned into the bundle. There is no implicit "current machine" default. Marker
   values that cannot be derived must be configured when a dependency references them.
5. Collection is wheels-only in v1. A package version without a compatible wheel for a
   target environment is a reported error carrying `requiredBy`. Transferring or
   building sdists is out of scope.
6. Package metadata comes from the PEP 691 JSON simple index and PEP 658/714 core
   metadata files, cached by source index and artifact identity. Source artifact and
   metadata hashes are verified; the bundle records a locally computed sha256.
7. v1 inputs: `requirements*.txt`, `uv.lock`, `pylock.toml`, direct
   `target add pypi` specs, and SHA-256-pinned `target add python-wheel` URLs. Root
   wheels are downloaded once, verified, and their embedded core metadata supplies the
   exact root plus dependency edges before the resulting closure is recorded. Development requirements are included when the existing
   `includeDev` policy is enabled. A `pyproject.toml` without a supported lockfile is
   reported with guidance instead of being resolved implicitly. Git, URL, and path
   Python requirements are reported and skipped with `requiredBy` context. Other
   lockfile formats can be added later behind the same internal model.
8. v1 uses one anonymously readable PEP 691 JSON source index. Private source index
   credentials and multiple/extra indexes are out of scope.
9. PEP 440 versions and specifiers use `@renovatebot/pep440`; wheel filename parsing
   and tag compatibility (PEP 427/425) are implemented in-house.

## Consequences

- There is no dist-tag analogue: pip's notion of "latest" is the highest
  non-prerelease version present in the index, which is automatically consistent with
  whatever the bundle publishes. The npm tag/latest policy machinery has no Python
  counterpart.
- The bundle format gains a package type where one `name@version` maps to multiple
  files selected per target environment.
- Bundles built from unpinned inputs may be incomplete for pip's backtracking
  resolution; the documented recommendation is to lock Python projects. Install
  verification requires a Python interpreter and is skipped with a report entry where
  none exists.
- Pure-source packages (no published wheels) fail collection visibly instead of
  silently pulling a build-toolchain requirement into the closed network.
- Gitea deployments gain requirements: the packages feature enabled, a dedicated
  public owner for the PyPI registry, and package size limits sized for the largest
  expected wheels.
