# Maintained Python Application Recipes

Recipes capture reviewed exceptions or application-specific choices that cannot be
derived reliably from normal package metadata. They are planning inputs, not installers,
lockfiles, or replacements for the general Gitea PyPI repository contract.

A recipe may:

- select an optional extra known to match a requested feature;
- document a platform branch that upstream does not publish as wheels;
- constrain an otherwise ambiguous application-specific choice;
- provide a small, non-destructive health check for explicit verification.

A recipe should not encode a package-manager version, duplicate the dependency graph,
or make consumers use generated airgap-sync files. Applications whose wheel metadata is
sufficient should work without a recipe.

`compatibility.applicationVersions` limits where the recipe applies, not which
application versions the target may select. Newer versions use generic planning;
selected recipe features require a recipe that covers the candidate release. Use an
exact target selector to pin a version.

New schema-v2 workspaces receive local copies under `.airgap-sync/recipes`. Current
planning records the normalized recipe digest so a local edit or an expired review
invalidates earlier evidence.

## KTransformers fixture

`ktransformers-0.6.1.post1.json` is the maintained complex example, not a special
architecture path. It records the reviewed release and its current native-platform
boundary: `kt-kernel` publishes Linux x86-64 wheels but no native Windows wheel. A
Windows + Linux request therefore cannot claim complete wheels-only coverage for that
release. A Linux-only target can make acceleration intent explicit:

```sh
airgap-sync target add python-app ktransformers . \
  --platform linux-glibc-x86_64 \
  --feature accelerator=cuda
airgap-sync plan .
```

CUDA is application intent; collection does not probe a GPU. CUDA drivers, system
libraries, model configuration, and model weights are outside the Python package
bundle. The same generic completeness rules apply to KTransformers as to every other
application.
