# Maintained Python application recipes

Recipes capture reviewed application compatibility decisions without inspecting the
collector or consumer machine. They are inputs to planning, not installers.

## KTransformers

The maintained `ktransformers-0.6.1.post1.json` recipe selects the last reviewed
KTransformers release that has a root wheel and a wheels-only Linux dependency
closure. Its `kt-kernel` dependency publishes Linux x86-64 wheels and no native
Windows wheel, so a Windows + Linux request is rejected as incomplete. Narrow the
target to `linux-glibc-x86_64` before replanning; do not publish a partial broad plan.

New schema-v2 workspaces receive a local copy under `.airgap-sync/recipes`. Adding a
KTransformers target automatically records that recipe. Add an explicit acceleration
intent when required:

```sh
airgap-sync target add python-app ktransformers . \
  --coverage desktop-x64 \
  --feature accelerator=cuda
airgap-sync plan .
```

For a Linux-only target, use `--platform linux-glibc-x86_64`. The planner chooses a
compatible Python minor, infers the glibc floor from the complete wheel closure, and
generates standard pip/uv consumer contracts. CUDA selection is explicit application
intent; no GPU is probed during planning.

Model configuration and weights are application data. Transfer them through a
separate, integrity-controlled data workflow; they are not PyPI dependencies and are
not included in an airgap-sync Python application bundle.
