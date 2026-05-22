# Contributing

This project is early and the main contribution target is clarity: behavior should be
documented before it becomes code.

## Local Workflow

```bash
npm ci
npm run build
npm run cli
npm run check
```

Before opening a change, run:

```bash
npm run format
npm run check
```

## Branches

Use focused branches:

```bash
git checkout -b feature/resolve-tags
git checkout -b fix/publish-report
```

## Design Changes

For behavior that affects install semantics, bundle format, or publish safety, add or
update an ADR in `docs/decisions/`.

## Commit Style

Use short imperative messages:

```text
Add bundle manifest schema
Document tag restoration policy
Fix package alias resolution
```
