# 0012: Remove Legacy Python Seeding

Date: 2026-08-09

## Status

Accepted. Supersedes [ADR 0007](0007-retain-legacy-python-seeding-until-1.0.md)
for raw PyPI, exact-wheel, repository-requirement, and repository-lockfile seeding.

## Context

The legacy path scanned Python files from arbitrary local and Git projects, combined
locked and unlocked inputs, and used a separate no-backtracking resolver for uncovered
requirements. A Git repository such as `llama.cpp` can contain converters, GUIs,
benchmarks, tests, and mutually incompatible development requirements. Treating every
such file as one deployable application creates an accidental and often unsatisfiable
coverage contract.

The maintained `python-app` path now has explicit application identity, version and
platform coverage, recipes, resolver evidence, content-addressed artifacts, security
evidence, and normal Gitea PyPI installation. Portable interpreters have the separate
`cpython-distributions` target.

## Decision

1. Remove `python.legacySeed`, raw `pypi` and `python-wheel` workspace targets, target
   `pythonResolutionMode`, and `download --allow-approximate-python`.
2. Stop scanning `requirements*.txt`, `uv.lock`, `pylock.toml`, or `pyproject.toml`
   from local roots and Git mirrors during collection.
3. Remove the legacy resolver, discovery, root-wheel, fetch, report, menu, and public
   API surfaces.
4. Do not reuse or retain files from the retired `python-packages/` storage in a new
   Python application bundle. A successful pruned download removes those files.
5. Keep `python-seed-manifest.json` as the current compatibility manifest for
   `python-app` wheel publication, security, the bundle-only Simple API, and install
   verification. Its filename does not enable legacy discovery or resolution.
6. Reject legacy-only bundle publication and removed workspace target types instead
   of silently interpreting them.
7. Add repository tools such as converters, GUIs, benchmarks, or test utilities only
   through a future explicit application-level contract and maintained recipe.

## Consequences

- Cloning `llama.cpp` no longer attempts to resolve its Python tooling requirements.
- Git/npm collection and Python application planning are independent.
- Existing workspaces must remove `python.legacySeed` and replace raw Python targets
  with explicit `python-app` targets where an application contract exists.
- The codebase has one supported dependency-resolution path for Python applications.
