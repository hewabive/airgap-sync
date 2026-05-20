# CLI Contract

The final CLI should keep fetch and publish separate so the online and offline phases
are auditable.

## fetch

```bash
npm-registry-seed fetch react@latest @types/node@^22 \
  --output ./seed \
  --registry https://registry.npmjs.org
```

Planned options:

```text
<spec...>                  Package specs to seed, e.g. react@latest
-o, --output <dir>        Bundle output directory
-r, --registry <url>      Source registry URL
--manifest <path>         Read root dependencies from a package.json
--include-dev             Include root devDependencies
--include-peer            Traverse peerDependencies
--concurrency <number>    Concurrent registry and download operations
--dry-run                 Resolve and report without downloading
--debug                   Verbose diagnostics
```

At least one package spec or `--manifest` is required.

## publish

```bash
npm-registry-seed publish ./seed \
  --registry http://192.168.0.10:4873
```

Planned options:

```text
-r, --registry <url>      Target registry URL
--concurrency <number>    Concurrent publish operations
--no-skip-existing        Attempt to publish versions that already exist
--dry-run                 Print planned operations without publishing
--debug                   Verbose diagnostics
```

## info

```bash
npm-registry-seed info ./seed
```

Prints bundle contents, package counts, tag counts, and unresolved specs.
