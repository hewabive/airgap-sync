# 0002: Restore Only Required Tags

Date: 2026-05-20

## Status

Accepted

## Context

Npm tags are global aliases per package. In a shared Verdaccio registry, assigning a tag
to a project-specific version can break other projects.

## Decision

Only restore tags that were actually used as dependency specifiers during resolution,
and restore them to the version they pointed to in the source registry at fetch time.

## Consequences

- We avoid downloading every tagged version of every package.
- Shared registry behavior stays aligned with the source registry for used tags.
- The bundle report must explain why each restored tag exists.
