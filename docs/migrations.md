# Workspace Migrations

The workspace compatibility rule is **migrate persisted formats, preserve supported
behavior**. When `airgap-sync` opens an existing workspace, it upgrades the
configuration before normal operations use it.

These migrations describe compatibility with existing files, not the current Python
consumer contract. Managed CPython and consumer package managers are independent from
application repository coverage. See [Python Support](python.md).

## Invariants

- Migrations run in a fixed order and have stable ids.
- A migration must be idempotent and safe to retry after interruption.
- Legacy input is parsed and the resulting current format is validated before writing.
- Configuration replacement is atomic.
- The original configuration is backed up before the first write.
- Old persisted shapes belong in migration code, not new business logic.
- Target behavior and file format lifetime are separate decisions. Migrating a legacy
  target does not remove support for that target.

## Registered migrations

| id                                    | source                         | destination                     | backup                                                           |
| ------------------------------------- | ------------------------------ | ------------------------------- | ---------------------------------------------------------------- |
| `0001-workspace-schema-v2`            | workspace schema v1            | workspace schema v2             | `airgap-sync.json.v1.backup`                                     |
| `0002-python-application-publication` | early schema v2 without owners | legacy publication defaults     | `airgap-sync.json.before-0002-python-publication.backup`         |
| `0003-python-publication-profile`     | legacy Python owner strings    | typed Gitea publication profile | `airgap-sync.json.before-0003-python-publication-profile.backup` |

`0001` maps legacy Python configuration into `python.legacySeed`, preserves all
targets and common settings, and installs maintained Python application recipes.
Application coverage remains empty because exact legacy environments do not imply a
broad Windows/Linux application policy.

`0002` repairs early schema-v2 workspaces that could omit the legacy Python owner
strings so that `0003` has an explicit input.

`0003` maps the untouched `pypi`/`python-apps` pair to one managed public
`airgap-packages` organization and removes the legacy strings. Custom legacy names
cannot be classified safely as users or organizations, so migration stops with an
actionable request to configure `python.publication.owner` and its explicit kind.

Early development builds could write `python.artifactTransfer`, `python-runtime`
targets, and the backup filename
`airgap-sync.json.before-0004-python-runtime-transfer.backup`. There is no registered
`0004` migration: that unused transfer experiment was removed. Unknown
`python.artifactTransfer` data is dropped when a current configuration is normalized;
replace any `python-runtime` target with `cpython-distributions` before opening it.

## Operator behavior

The interactive menu reports a migration once:

```text
[migration] applied 0001-workspace-schema-v2; backup: /path/to/airgap-sync.json.v1.backup
```

No command is required for the normal upgrade. To inspect the result without changing
the workspace:

```bash
airgap-sync migrate /path/to/workspace --dry-run
```

To roll back for an older binary, stop all `airgap-sync` processes and deliberately
restore the backup as `airgap-sync.json`. A newer binary will migrate it again when the
workspace is reopened.
