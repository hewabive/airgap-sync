# CLI Contract

The final CLI should keep fetch and publish separate so the online and offline phases
are auditable.

## fetch

```bash
airgap-sync fetch react@latest @types/node@^22 \
  --output ./seed \
  --registry https://registry.npmjs.org

# Or from a project manifest. The manifest directory is scanned recursively for nested
# package.json files, excluding node_modules and build/cache directories.
airgap-sync fetch --manifest ./package.json \
  --output ./seed
```

Planned options:

```text
<spec...>                  Package specs to seed, e.g. react@latest
-o, --output <dir>        Bundle output directory
-r, --registry <url>      Source registry URL
--manifest <path>         Read dependencies from a package.json or directory
--include-dev             Include devDependencies from discovered manifests
--include-peer            Traverse peerDependencies
--concurrency <number>    Concurrent registry and download operations
--dry-run                 Resolve and report without downloading
--debug                   Verbose diagnostics
```

At least one package spec or `--manifest` is required.

`--dry-run` performs the same dependency traversal as a normal fetch, including
transitive dependencies and publish-time `latest` targets, but reads package manifests
from registry metadata instead of downloading tarballs.

When `--manifest` points at a package.json, the containing directory is treated as the
scan root. When it points at a directory, that directory is the scan root. Nested
package.json files are included so monorepositories can be seeded from the repository
root. Local workspace dependencies are skipped when their package names are discovered
inside the same scan root.

## publish

```bash
airgap-sync publish ./seed \
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

Current MVP behavior publishes tarballs sequentially with a temporary tag, then restores
the required tags from `dist-tags.json`. Before running npm publish commands, it
validates that bundle manifests are internally consistent and every referenced tarball
exists.

## info

```bash
airgap-sync info ./seed
```

Prints a JSON summary with package counts, package names, restored tags, report status,
missing tarball files, and bundle validation issues.
