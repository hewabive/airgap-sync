# Windows launchers

These batch files are optional operator launchers for removable-media workflows.
They are meant to be copied to a Windows machine, for example to the Desktop.

- `airgap-download.bat` is for the online machine. It finds the removable drive
  workspace, runs `git pull --ff-only`, refreshes dependencies and rebuilds only when
  Git changed or local install/build output is missing, and then runs
  `airgap-sync download`.
- `airgap-publish.bat` is for the closed-network machine. It finds the same
  removable drive workspace and runs the already-built `airgap-sync publish`.

By default the launchers search drives `D:` through `Z:` for:

```text
X:\airgap-sync\package.json
```

If the workspace path is different, set `AIRGAP_SYNC_WORKSPACE` before running a
launcher:

```bat
set AIRGAP_SYNC_WORKSPACE=G:\airgap-sync
airgap-download.bat
```

If only the folder name is different, set `AIRGAP_SYNC_WORKSPACE_FOLDER`:

```bat
set AIRGAP_SYNC_WORKSPACE_FOLDER=my-airgap-sync
airgap-publish.bat
```

Any arguments passed to a launcher are forwarded to the underlying command:

```bat
airgap-download.bat --target 2
airgap-publish.bat --dry-run
```
