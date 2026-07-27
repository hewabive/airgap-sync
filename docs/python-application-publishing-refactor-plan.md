# Python Application Publishing Refactor Plan

Status: proposed  
Date: 2026-07-27

This document proposes the next Python architecture for `airgap-sync`. It does not
change the current implementation by itself. After acceptance, an ADR must supersede
the conflicting parts of
[ADR 0005](decisions/0005-python-package-transfer-without-python.md).

The implemented v1 package-transfer design remains documented in
[python-support-plan.md](python-support-plan.md).

## Executive Decision

Python support becomes application-first:

```text
application intent + bounded platform coverage policy
  -> choose a compatible application version and Python runtime contract
  -> produce a full backtracking lock for each platform family
  -> download every relevant wheel variant for the selected versions
  -> infer and report actual compatibility boundaries
  -> write an immutable environment plan and per-platform consumer locks
  -> publish artifacts to closed-network registries
  -> install with standard Python tooling outside airgap-sync
```

The normal operator should provide:

1. what application to make available;
2. which broad platform families to cover.

The normal operator should not provide:

- an exact Python patch version;
- `manylinux`, ABI, or wheel tags;
- `locked-only` versus `approximate`;
- individual wheel URLs or hashes.

Those remain inspectable facts in plans and reports. Explicit overrides remain
available only in advanced configuration.

## Why The Current Model Must Change

The v1 implementation is package-transfer-first. It assumes the operator already knows
the target Python environments and asks for:

- full Python version;
- operating system and architecture;
- Linux libc compatibility;
- a resolution policy;
- optional runtime archive details.

This is appropriate for an expert mirroring packages for several known Python
environments. It is not an appropriate default for preparing an application for a
heterogeneous Windows/Linux fleet.

The current components are also disconnected:

- `PythonTargetEnvironmentConfig` decides marker and wheel compatibility;
- `resolver.ts` resolves packages;
- `python-runtime` is a separate manually pinned target;
- `python-seed-manifest.json` describes a shared package pool;
- install verification looks for a matching interpreter already present on the
  verifier;
- publish populates Gitea, but there is no first-class application environment plan.

As a result, a user can choose a Python runtime that the application does not support,
or choose a libc baseline without knowing what it means. The tool discovers the
mistake late and reports it in packaging vocabulary.

## Product Principles

### 1. Application intent is different from package seeding

A Python application needs one isolated, internally consistent environment. A PyPI
package seed target merely asks to mirror packages into a registry.

The new model introduces a `python-app` target. Existing `pypi` targets remain as an
advanced registry-seeding feature and are not presented as the primary way to prepare
an application.

### 2. Coverage describes platform classes, not physical machines

The planner does not maintain an inventory of destination computers. The normal input
is a reusable coverage policy such as:

- Windows on `x86_64`;
- mainstream glibc-based Linux on `x86_64`.

Ubuntu, Debian, Rocky Linux, RHEL, and similar glibc distributions are not separate
resolver targets. Linux compatibility is expressed by the wheel's `manylinux` glibc
floor and architecture. Musl-based Linux is a separate family.

An optional, versioned distribution-hint catalog maps familiar OS releases to
compatibility facts for UI explanations. It is not the source of truth and an unknown
distribution is not an error.

`airgap-sync probe` remains an optional diagnostic command that compares one real
machine with an existing environment plan. It is not required before planning or run
across an entire fleet.

### 3. Installation remains outside airgap-sync

`airgap-sync` transfers and publishes artifacts. It does not become an application
installer, runtime manager, service manager, or configuration-management system.

The environment plan declares a compatible Python minor and other machine
prerequisites. Consumer machines provision Python through their normal infrastructure
and install from the closed-network registry with standard `pip` or `uv` commands.

`verify install` may create a temporary environment to test the published result. This
is verification of the consumer workflow, not production deployment. `airgap-sync`
never replaces `/usr/bin/python3`, installs into system site-packages, creates
production launchers, or owns rollback.

### 4. New application plans use a real resolver

The simplified no-backtracking resolver is not suitable for automatically selecting a
runtime. The new application path uses a pinned standalone `uv` executable as the
resolution engine. `uv` can resolve for a target Python version and target platform
without requiring Python to be preinstalled on the collector.

The existing TypeScript code remains responsible for:

- orchestration and policy;
- PyPI metadata and artifact integrity;
- coverage normalization and reporting;
- candidate scoring;
- bundle manifests and reports;
- Gitea publishing;
- generation of consumer locks and configuration.

The existing resolver remains only for v1 compatibility until migration is complete.

### 5. An environment plan is immutable and auditable

Planning and downloading are separate concepts. Once generated, a plan pins:

- application name and version;
- coverage-policy digest;
- resolver and policy versions;
- compatible Python runtime constraint;
- every package version and wheel;
- all source URLs and hashes;
- registry publication details;
- standard installation and verification instructions.

Repeated download of an unchanged plan must produce the same artifact set. Moving to
newer application, Python, or dependency versions requires an explicit replan.

### 6. Download breadth is bounded

`all-compatible-wheels` means all wheel variants for the selected package versions
that match the requested OS families, architectures, Python minor, and supported ABIs.
It does not mean all package versions, Python versions, architectures, operating
systems, sdists, or accelerator builds.

Before download, the plan reports total and incremental bytes per platform branch and
feature. Expanding coverage is always visible and never silently enables another
accelerator or architecture.

CPU, CUDA, ROCm, and similar variants are explicit application features only when they
change the artifact closure. Exact hardware models and driver inventories are not
normal planning inputs.

### 7. Plans never assume a shared consumer environment

Two applications may require conflicting versions of the same package. They may share
downloaded files and registry packages, but each receives its own lock. Consumer
documentation recommends a separate virtual environment per application; creating and
managing that environment remains the consumer's responsibility.

## Scope

The first production scope is:

- Windows on `x86_64`;
- mainstream glibc-based Linux on `x86_64`;
- CPython;
- applications published on a PEP 503/691-compatible index;
- wheels-only dependency closure with `all-compatible-wheels` collection;
- publication to Gitea's PyPI registry;
- publication of environment plans, locks, and configuration to Gitea's Generic
  Packages registry;
- optional transfer of CPython and `uv` archives to a generic artifact registry,
  without installing them;
- explicit application feature variants when they change the artifact set.

The domain model must allow later support for ARM64, macOS, musl, Git Python
applications, and private indexes. They are not required for the first vertical slice.

Building sdists is not part of this refactor. If no compatible wheel exists, the plan
reports the minimum machine change or the need for an externally built wheel.

## Proposed User Experience

### Choose broad coverage

Built-in platform families are few and stable:

```text
windows-x86_64
linux-glibc-x86_64
```

The workspace may select one or both as its default coverage. Distribution names are
not required.

```bash
airgap-sync target add python-app ktransformers \
  --platform windows-x86_64 \
  --platform linux-glibc-x86_64
airgap-sync plan
```

The menu asks for an application and broad platform families. Python compatibility is
selected automatically. `all-compatible-wheels` is the default and is not shown as a
question.

For each selected package version, collection includes every wheel matching the
requested OS family, architecture, selected Python minor, or a compatible stable ABI.
The planner publishes the union and writes a separate consumer lock when platform
markers produce different dependency branches.

The result reports coverage rather than a guessed destination:

```text
Application: ktransformers 0.6.2
Runtime contract: CPython >=3.11,<3.12
Coverage:
  Windows x86_64: supported
  Linux glibc x86_64: supported, requires glibc >= 2.35
Resolution: complete, 74 packages / 96 wheel variants
Publish target: Gitea PyPI / owner pypi
Plan and lock: Gitea Generic Packages / owner python-apps
Status: ready to download
```

An unsupported branch is reported without pretending that all Linux systems are
equivalent:

```text
Requested coverage is incomplete.

Windows x86_64:
  no compatible kt-kernel wheel was published

Linux glibc x86_64:
  supported with glibc >= 2.35

Possible actions:
- remove Windows from the requested coverage;
- provide a compatible pre-built Windows wheel;
- choose an older application version if one covers both families.
```

Raw wheel tags are available in `--verbose` and JSON reports, not in the default
message.

### Use distribution hints only for explanation

The optional distribution-hint catalog translates a technical boundary into familiar
examples:

```text
Required: glibc >= 2.35

Known examples:
  Ubuntu 22.04 and newer: compatible
  Ubuntu 20.04: incompatible
```

The catalog is versioned data, may be updated independently from resolver code, and
does not attempt to enumerate every Linux distribution. The plan remains valid when a
distribution is absent from the catalog.

### Diagnose one machine when needed

Probe is a comparison tool, not a planning prerequisite:

```bash
airgap-sync probe --compare ktransformers--linux-glibc-x86_64.plan.json
```

It reads only facts referenced by the plan: OS family, architecture, libc family and
version, Python version when present, and explicitly requested feature capabilities.
It does not collect a full CPU/GPU inventory, host identity, network addresses, serial
numbers, or tokens.

A standalone diagnostic script may be shipped for machines without Node.js. Probe
output is ephemeral unless the operator explicitly saves it.

### Download, publish, and install normally

```bash
# Online
airgap-sync download

# On the registry host inside the closed network
airgap-sync publish
```

Publishing uploads the complete wheel closure to Gitea PyPI and the environment plan,
consumer lock, and configuration to Gitea Generic Packages. It does not modify
consumer machines.

On a consumer machine, after Python has been provisioned by the normal infrastructure:

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install \
  --index-url http://gitea.local/api/packages/pypi/pypi/simple/ \
  --only-binary=:all: \
  --no-deps \
  --require-hashes \
  -r ktransformers--linux-glibc-x86_64--py311.requirements.lock

.venv/bin/python -m pip check
```

`uv pip sync` or `uv sync` may be used when the generated lock format supports it.
These are consumer commands, not `airgap-sync` subcommands.

The lock is essential when a shared registry contains versions for several
applications or platform families. Installation must not resolve a different closure
merely because newer packages were later published.

## Proposed Workspace Model

`airgap-sync.json` schema v2 separates Python service settings, reusable coverage
policies, and application intent:

```json
{
  "schemaVersion": 2,
  "python": {
    "sourceIndex": "https://pypi.org/simple/",
    "publishOwner": "pypi",
    "applicationArtifactOwner": "python-apps",
    "planner": {
      "engine": "uv",
      "version": "pinned-by-airgap-sync"
    }
  },
  "coveragePolicies": [
    {
      "id": "desktop-x64",
      "platforms": ["windows-x86_64", "linux-glibc-x86_64"],
      "wheelStrategy": "all-compatible"
    }
  ],
  "targets": [
    {
      "type": "python-app",
      "spec": "ktransformers",
      "coverage": "desktop-x64",
      "python": {
        "policy": "auto"
      }
    }
  ]
}
```

Advanced overrides are nested under the application target:

```json
{
  "python": {
    "policy": "constrained",
    "version": ">=3.11,<3.12"
  },
  "application": {
    "version": "==0.6.2",
    "extras": [],
    "features": {
      "accelerator": "nvidia-cuda-12"
    }
  },
  "coverage": {
    "linux": {
      "oldestSupportedGlibc": "2.28"
    }
  }
}
```

There is no top-level `pythonResolutionMode` in the v2 application path. There is no
required distro or `manylinux` field. An optional glibc floor is an advanced coverage
constraint, not a description of one computer.

## Domain Model

### PlatformFamily

Small built-in compatibility classes understood by Python packaging:

- stable family ID;
- OS family;
- architecture;
- optional libc family;
- accepted wheel-platform tag families;
- family-definition version;
- support status.

Initial families are `windows-x86_64` and `linux-glibc-x86_64`. Musl, macOS, and new
architectures are added as new families rather than as distro-specific exceptions.

### PlatformCoveragePolicy

Reusable operator intent:

- requested platform families;
- wheel strategy (`all-compatible` by default);
- optional advanced compatibility floors;
- optional explicit application feature variants;
- policy version and canonical digest.

The policy describes the desired registry coverage, not a list of hosts.

### DistributionHintCatalog

Optional, versioned presentation data:

- distribution ID, aliases, and release as represented by `os-release`;
- libc family and version normally shipped by that release;
- human-readable support notes;
- provenance and last-reviewed date.

Hints improve messages such as “Ubuntu 22.04 is a known matching example.” Resolver
correctness never depends on a distro being present in this catalog. Rolling releases
and locally upgraded libc versions are not assigned a guaranteed boundary; optional
probe compares their actual libc directly.

### PythonApplicationIntent

Long-lived operator intent:

- source type and application spec;
- explicit version constraint or stable-version policy;
- coverage-policy reference or inline coverage;
- Python compatibility policy (`auto` by default);
- extras or feature selection;
- optional recipe reference;
- update policy.

It does not contain resolved versions or artifact URLs.

### PythonApplicationRecipe

Optional expert knowledge that package metadata cannot express:

- preferred Python minor order;
- supported application versions;
- required extras;
- system-library prerequisites;
- explicit artifact-changing feature variants such as CUDA or ROCm;
- optional runtime capability checks that do not affect resolution;
- known incompatible combinations;
- entry points and non-destructive health checks;
- upstream documentation references;
- expiry/revalidation date.

Resolution must still validate the complete wheel closure. A recipe guides candidate
selection; it never bypasses compatibility or integrity checks.

Recipes use a provider interface. Workspace-local recipes are supported first. Built-in
recipes are added only when covered by a maintained fixture and end-to-end test.

### PythonPlatformPlan

One resolved branch of an application plan:

- platform-family ID;
- selected Python minor and runtime constraint;
- complete platform-specific lock;
- selected package versions;
- every relevant wheel variant and hash;
- inferred compatibility boundary such as minimum glibc;
- supported or rejected status and reasons.

### PythonEnvironmentPlan

Generated immutable output:

- plan ID and schema version;
- application intent snapshot;
- selected application version;
- coverage policy, resolved family definitions, and digest;
- one `PythonPlatformPlan` per requested platform family;
- preferred common Python minor when one works across all branches;
- optional runtime and tool artifact references when transfer is enabled;
- resolver inputs, options, and timestamp cutoff;
- complete platform-specific dependency graphs;
- deduplicated union of selected wheels with hashes and compatibility reasons;
- shared-artifact references;
- Gitea publication coordinates;
- consumer lock files, index configuration, and standard install commands;
- non-destructive verification commands;
- warnings and rejected candidate summaries.

The plan ID is a digest of normalized semantic content, excluding creation timestamps
and presentation text.

The default `requirements.lock` contains index-neutral `name==version` entries and
accepted SHA-256 hashes, not public index URLs or credentials. This allows the same
lock to be consumed from Gitea without being rewritten after publication.

Each platform lock accepts the hashes of all collected wheel variants for its locked
package versions. The consumer's standard package finder selects the locally compatible
wheel; it cannot select a different version or an uncollected artifact.

## Planning Algorithm

### Inputs

Candidate selection combines:

1. an explicit application version, when supplied;
2. supported upstream lockfiles or constraints;
3. workspace-local application recipes;
4. `Requires-Python`, dependency markers, and published wheel metadata;
5. the project's supported CPython-minor policy;
6. the requested coverage policy;
7. a reproducibility cutoff for index uploads.

Free-form upstream documentation is not parsed automatically. Important guidance is
captured in a reviewed recipe with provenance.

### Candidate generation

For each acceptable stable application version:

1. derive Python minors allowed by metadata, lockfiles, and recipes;
2. discard Python minors outside the supported project policy;
3. expand glibc Linux into an ordered, versioned set of meaningful manylinux baseline
   candidates, pruning impossible floors from root wheel metadata;
4. build a platform-family × Python-minor × applicable-baseline candidate matrix;
5. invoke the pinned `uv` resolver for each branch so platform markers and wheel
   availability are evaluated correctly;
6. retain the lowest successful glibc baseline for each otherwise equivalent Linux
   candidate;
7. for every locked package version, enumerate all published wheels matching the
   requested OS family, architecture, Python minor, and supported ABIs;
8. include universal wheels once and retain all matching platform-specific variants;
9. validate wheel tags, `Requires-Python`, hashes, and metadata with the existing
   TypeScript machinery;
10. require at least one installable wheel for every package in every requested
    branch;
11. verify the inferred Linux glibc floor against the resolved baseline;
12. retain successful environment candidates and per-branch rejection reasons.

`uv` performs dependency backtracking. The TypeScript planner performs the outer search
across application versions, Python minors, and platform families. Feature families
such as CPU-only, CUDA, or ROCm are searched only when explicitly requested by the
application intent or recipe.

`all-compatible-wheels` is applied after versions are locked. It never expands the
search to unrelated package versions, Python minors, architectures, operating systems,
sdists, or unrequested accelerator indexes.

For `linux-glibc-x86_64` with no explicit baseline, the planner searches supported
manylinux floors from older to newer and reports the first complete closure. The final
minimum glibc is verified as the highest of the lowest usable floors needed by packages
in that closure. If an advanced `oldestSupportedGlibc` baseline is supplied, the branch
succeeds only when every package has a wheel usable at that baseline. In either case,
newer wheel variants of the locked package versions are also collected for newer
consumers.

### Scoring

Successful candidates are ordered deterministically:

1. an upstream lock or explicit application version;
2. complete support for every requested platform family;
3. a matching reviewed recipe;
4. non-yanked stable packages only;
5. the newest application version satisfying the requested coverage;
6. a common CPython minor across branches when possible;
7. the recipe's Python preference;
8. the broadest Linux glibc compatibility within otherwise equivalent candidates;
9. deterministic version ordering as the final tie-breaker.

The selected plan records the score and why alternatives were rejected. The exact
scoring weights are versioned policy, not hidden heuristics.

If no application version covers every requested family, no ready plan is activated.
The report preserves partial branch results and suggests narrower coverage, an
alternate application version, or a supplied wheel.

### Replanning

`download` does not silently change a valid application plan. The operator requests:

```bash
airgap-sync plan --update ktransformers
```

An update report compares application, runtime, package, artifact, and prerequisite
changes before the new plan replaces the active one.

## Bundle Layout

Shared content remains deduplicated while plans stay application-specific:

```text
airgap-bundle/
  python/
    applications/
      ktransformers--desktop-x64/
        environment-plan.json
        lock/
          windows-x86_64--py311.requirements.lock
          linux-glibc-x86_64--py311.requirements.lock
          windows-x86_64--py311.pylock.toml
          linux-glibc-x86_64--py311.pylock.toml
        publish-manifest.json
    artifacts/
      wheels/
        <sha256>/<filename>.whl
      optional/
        runtimes/
          <sha256>/<archive>
        tools/
          uv/<platform>/<version>/<executable>
  python-seed-manifest.json
  python-fetch-report.json
```

During migration, the existing `python-packages/` layout and Gitea publisher remain
readable. A bundle index maps v2 artifact identities to legacy publish paths without
duplicating large wheels where hard links or safe copies are available.

Prune operates from references in every active environment plan. Removing one
application cannot remove a wheel or runtime still referenced by another.

## Closed-Network Publication And Consumer Contract

The closed-network phase remains a publication operation:

1. verify bundle and environment-plan hashes;
2. upload every referenced wheel to Gitea's PyPI registry;
3. publish the environment plan, application lock, `pip.conf`/index settings,
   prerequisite report, and verification commands to Gitea's Generic Packages
   registry;
4. optionally upload CPython or `uv` archives to the same generic artifact registry;
5. record idempotent publication results in the run history.

Installation then belongs to the consumer or its configuration-management system. The
expected sequence is to provision a compatible Python, create an isolated environment,
and install the generated lock using standard tooling pointed exclusively at the
closed-network registry.

The default lock is fully pinned and hash-complete. Consumer instructions use
`--only-binary=:all:`, `--no-deps`, and `--require-hashes`, followed by `pip check`.
They do not require a source build or dependency resolution. `airgap-sync` may execute
the same commands in a temporary directory through `verify install`, but it does not
create, update, launch, or roll back production application environments.

## Diagnostics

Diagnostics are layered:

1. **Intent:** application/version could not be selected.
2. **Coverage:** a requested platform family or explicit feature variant is
   unsupported.
3. **Runtime contract:** no supported CPython minor has a complete compatible closure.
4. **Resolution:** dependency constraints conflict.
5. **Artifact:** compatible wheel is missing.
6. **Transfer:** hash, download, or bundle error.
7. **Consumer verification:** prepared runtime, install, or health-check failure.

Default output explains the first actionable boundary. JSON includes the complete
candidate matrix and low-level packaging details.

## Migration And Compatibility

This must be an incremental refactor, not a flag-day rewrite.

- Opening a workspace automatically migrates schema v1 to schema v2 and maps its
  Python configuration to explicit `legacy-python-seed` intents.
- Existing `git`, `pypi`, `python-wheel`, and `python-runtime` targets continue to
  work during the migration.
- Existing `python-seed-manifest.json` and Gitea publication remain supported.
- `pythonTargetEnvironments`, `pythonResolutionMode`, and
  `--allow-approximate-python` are marked legacy only after `python-app` reaches
  end-to-end parity.
- `airgap-sync migrate --dry-run` remains an optional non-writing preview; normal
  workspace opening applies the validated migration automatically after creating a
  backup.
- Existing explicit Python environments map to advanced legacy coverage constraints
  without inventing distro names or widening their platform scope.
- Migration may suggest an equivalent built-in coverage family, but applying that
  simplification is explicit.
- Removal of the legacy resolver and config fields requires a later major-version
  decision and its own ADR.

## Implementation Phases

Every phase lands independently with `npm run check` green.

### Phase 0 — Decisions and executable spikes

- Write ADR 0006 to supersede the no-external-resolver and explicit-environment
  decisions in ADR 0005 while preserving its publish-only product boundary, Gitea
  publication, and integrity decisions.
- Pin a `uv` version and verify redistribution/licensing, checksums, and supported
  collector platforms.
- Prove `uv` target-platform resolution for Windows x86-64 and several manylinux
  baselines.
- Prove that collecting all matching wheels after resolution preserves a valid
  platform-specific closure.
- Prove deterministic minimum-glibc inference from wheel metadata.
- Prove deterministic, hash-complete `pylock.toml` and `requirements.lock` output.
- Publish a resolved closure to a test Gitea and install it with standard `pip` from
  that index on pre-provisioned Windows and Linux Python environments.
- Prove that the generated consumer command cannot fall back to an external index or
  source distribution.

Exit criterion: a checked-in spike resolves and publishes a small application for a
Windows/glibc-Linux coverage policy, then normal `pip` commands install the exact
platform locks from Gitea.

### Phase 1 — Domain types and schema v2

- Add `PlatformFamily`, `PlatformCoveragePolicy`, `DistributionHintCatalog`,
  `PythonApplicationIntent`, `PythonApplicationRecipe`, `PythonPlatformPlan`, and
  `PythonEnvironmentPlan` modules.
- Add canonical serialization and semantic digests.
- Add workspace schema-v2 normalization and an automatic, backed-up schema-v1
  migration boundary.
- Add coverage-policy and plan paths without changing current download behavior.
- Add migration preview, idempotence, backup, and round-trip tests.

Exit criterion: old workspace behavior survives automatic schema migration; new intents
and plans round-trip deterministically.

### Phase 2 — Coverage families and optional platform diagnostics

- Add built-in `windows-x86_64` and `linux-glibc-x86_64` families.
- Add `coverage list`, `coverage show`, and `coverage explain`.
- Add a small versioned distribution-hint catalog with provenance and review dates.
- Keep distro hints out of resolver correctness and plan identity.
- Add optional Windows and Linux `probe --compare` diagnostics that read only
  plan-referenced facts.
- Ship standalone diagnostic scripts only as a convenience for machines without
  Node.js.
- Add fixtures for Windows, glibc Linux across several baselines, musl Linux, and
  unknown distributions.

Exit criterion: planning a fleet requires no host inventory or distro selection;
probe can independently explain whether one machine satisfies an existing plan.

### Phase 3 — Planner and uv adapter

- Implement pinned `uv` acquisition for the collector.
- Add a narrow command-runner interface and machine-readable error mapping.
- Generate application × Python × platform-family candidate matrices.
- Resolve every platform branch with backtracking and wheels-only policy.
- Add ordered manylinux-baseline search with metadata pruning and shared caches.
- Implement `all-compatible-wheels` enumeration for locked package versions.
- Infer glibc support boundaries and validate optional advanced floors.
- Reuse current metadata, wheel-tag, marker, and integrity validation.
- Add deterministic scoring, partial-coverage reports, and rejected-branch
  explanations.
- Add `airgap-sync plan [--json] [--update <target>]`.

Exit criterion: planning a pure-Python and a native-wheel fixture automatically selects
Python, emits Windows/Linux branches, downloads every relevant wheel variant, and
reports the inferred Linux glibc floor.

### Phase 4 — Runtime contract and optional artifact transfer

- Derive a compatible Python constraint for each platform branch.
- Prefer one common Python minor across branches when it does not reduce requested
  coverage.
- Generate a prerequisite report for the consumer infrastructure.
- Keep runtime provisioning external to `airgap-sync`.
- Optionally mirror exact CPython and target-platform `uv` archives when a generic
  artifact destination is configured.
- Record source, version, hash, license, and intended generic-registry coordinates for
  optional artifacts.
- Preserve manual `python-runtime` targets as an advanced transfer feature.

Exit criterion: every plan has an actionable runtime contract. Optional runtime
transfer produces verified, publishable artifacts but no installation action.

### Phase 5 — Application bundle integration

- Add the v2 application/artifact layout and bundle index.
- Integrate plans into download, run history, info, verify, and prune.
- Store per-platform locks and a deduplicated union of wheel variants.
- Report total and incremental artifact sizes per platform branch and feature.
- Keep Gitea publication compatible with shared v2 wheel artifacts.
- Make partial target download and prune reference-aware across application plans.
- Add human-readable plan diff reports.

Exit criterion: repeated download is deterministic and two applications safely share
registry artifacts while retaining independent locks.

### Phase 6 — Consumer locks, configuration, and verification

- Generate a hash-complete `requirements.lock` plus `pylock.toml` for every supported
  platform branch.
- Generate `pip.conf`, `PIP_INDEX_URL`, and equivalent `uv` configuration snippets for
  the closed-network registry.
- Publish locks and prerequisite reports alongside the application plan in Gitea's
  Generic Packages registry.
- Extend `verify install` to use a matching externally provisioned interpreter, a
  temporary venv, the matching platform lock, and the Gitea index.
- Record a clear skip when the verifier has no compatible Python.
- Run recipe health checks only inside the temporary verification environment.
- Do not add production `deploy`, launcher, activation, or rollback commands.

Exit criterion: on a consumer with compatible Python already provisioned, the generated
standard `pip` or `uv` command installs the exact plan from Gitea; `airgap-sync` can
independently reproduce that flow as a temporary verification.

### Phase 7 — UX cutover

- Make `python-app` the normal menu entry.
- Replace initial Python environment questions with broad Windows/Linux coverage
  choices and workspace defaults.
- Keep `all-compatible-wheels` implicit in the normal flow.
- Present inferred glibc boundaries with optional distro examples.
- Move raw Python environments, wheel tags, runtime archives, and resolution policies
  under Advanced/Legacy.
- Rewrite summaries in application and coverage language.
- Add guided remediation for unsupported platform branches.

Exit criterion: the normal application workflow asks no Python packaging questions.

### Phase 8 — KTransformers vertical slice

- Add a maintained workspace recipe/fixture for the chosen KTransformers release.
- Request both Windows x86-64 and glibc-Linux x86-64 coverage and report unsupported
  branches precisely.
- Treat CUDA or other accelerator variants as an explicit feature, not machine
  inventory.
- Collect every relevant wheel variant for the selected Python and package versions.
- Infer the Linux glibc boundary from the actual closure and explain it with
  distribution hints.
- If the initial request is incomplete, require the operator to narrow coverage or
  supply a wheel and replan; never publish a silently partial plan.
- Publish every branch in the resulting ready plan and its complete dependency closure
  to Gitea.
- Emit per-platform runtime contracts, hash-complete consumer locks, and index
  configuration.
- Provision the matching Python outside `airgap-sync`, run the generated standard
  install command on compatible Windows/Linux test environments, and execute a
  non-destructive import/CLI health check where supported.
- Exercise optional CPython/`uv` artifact transfer separately from installation.
- Document model weights as a separate application-data concern, not a PyPI dependency.

Exit criterion: the user selects KTransformers plus broad Windows/Linux coverage and
receives either publishable platform branches plus standard consumer install
contracts, or an exact unsupported-platform explanation without entering Python,
distribution, manylinux, CPU, GPU, or resolver settings.

### Phase 9 — Hardening and legacy retirement decision

- Add fault-injection for interrupted downloads and publications.
- Validate idempotent republishing and reference-safe artifact garbage collection.
- Add reproducibility tests across repeated planning runs with a fixed cutoff.
- Measure large ML bundle performance and removable-media behavior.
- Complete security review for optional probe data, executable artifacts, generated
  consumer commands, registry credentials, and health checks.
- Decide in a new release ADR when legacy Python fields and resolver can be removed.

## Testing Strategy

### Unit

- coverage-policy normalization and family expansion;
- distribution-hint parsing without resolver coupling;
- candidate-matrix generation and scoring;
- all-compatible wheel enumeration and deduplication;
- ordered glibc-baseline search, pruning, and floor inference;
- optional probe comparison and privacy filtering;
- canonical plan hashing;
- uv command construction and error mapping;
- migration from every supported schema-v1 target shape;
- reference-safe artifact pruning.

### Fixture integration

- committed PyPI and managed-runtime catalog snapshots;
- a pure-Python application;
- a native-wheel application with several Python minors;
- dependency conflict requiring resolver backtracking;
- platform markers producing different Windows/Linux locks;
- multiple manylinux variants for one package version;
- no-wheel, glibc-floor, wrong-architecture, musl, and explicit accelerator-feature
  cases;
- an unknown Linux distribution that still maps directly to glibc compatibility;
- two applications requiring conflicting versions of one dependency.

### End-to-end

- online planning and download with pinned `uv`;
- Gitea publication followed by a standard exact-lock install with externally
  provisioned Windows and Linux Python;
- consumer verification in network-isolated glibc-Linux containers representing
  supported and unsupported baselines;
- clear verification skip when no compatible Python is present;
- optional probe comparison against an existing plan;
- interrupted publication and idempotent retry;
- KTransformers smoke test on suitable hardware outside generic CI.

All network-backed fixtures are captured with provenance and timestamps so regular
tests do not depend on mutable PyPI state.

## Security And Operational Boundaries

- Optional probe output excludes identity and network data and collects only
  plan-referenced compatibility facts.
- Planner `uv`, optional CPython/consumer-tool archives, and wheels are pinned and
  hash-verified.
- Source builds remain disabled; PEP 517 build hooks never execute in the normal flow.
- Generated consumer configuration points only to closed-network services and uses a
  hash-complete, wheels-only lock.
- Health checks are recipe-controlled, displayed in the plan, and non-destructive.
- System package installation, driver installation, kernel changes, and `sudo` are out
  of scope. The plan reports such prerequisites.
- Production environment paths, service lifecycle, activation, and rollback are owned
  by consumer infrastructure, not `airgap-sync`.

## Success Criteria

The refactor is complete when:

- a new operator can prepare and publish a Python application without selecting Python
  or understanding wheel tags;
- an operator can request broad Windows/Linux coverage without cataloging destination
  hosts or Linux distributions;
- the planner publishes every relevant wheel variant for the selected versions and
  bounds the expansion by OS family, architecture, Python, ABI, and explicit features;
- Linux support is reported as an inferred glibc boundary with optional distro hints;
- probe is optional diagnostics and does not participate in normal planning;
- every new application plan uses full backtracking resolution and exact hashes;
- the plan exposes a clear runtime prerequisite and optional runtime artifact transfer
  never implies installation;
- multiple applications can share registry artifacts while retaining independent
  locks;
- consumer installation uses standard `pip` or `uv` against closed-network services;
- `airgap-sync` does not own or mutate production Python environments;
- incomplete coverage reports an actionable platform/application boundary;
- planning, download, publish, verify, prune, and history understand the same immutable
  environment plan;
- the legacy workflow remains readable until an explicit major-version retirement.

## Recommended Delivery Order

The critical path is:

```text
ADR/spikes
  -> schema and domain model
  -> coverage families and hint catalog
  -> plan with uv
  -> runtime contract and optional artifacts
  -> bundle integration
  -> consumer locks and verification
  -> simplified UX
  -> KTransformers vertical slice
```

Do not start with menu redesign. The simplified menu becomes truthful only after
coverage normalization, real planning, bounded wheel expansion, deterministic
publication, and consumer lock generation exist underneath it.

## External References

- [uv resolution](https://docs.astral.sh/uv/concepts/resolution/)
- [uv managed Python versions](https://docs.astral.sh/uv/concepts/python-versions/)
- [uv command reference](https://docs.astral.sh/uv/reference/cli/)
- [Python platform compatibility tags](https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/)
- [PEP 600 manylinux compatibility](https://peps.python.org/pep-0600/)
- [pip package candidate selection](https://pip.pypa.io/en/stable/development/architecture/package-finding/)
- [pip cross-platform download options](https://pip.pypa.io/en/stable/cli/pip_download/)
