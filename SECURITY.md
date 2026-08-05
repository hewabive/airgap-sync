# Security Policy

## Security Model

airgap-sync is a local operator tool, not a sandbox. It downloads npm packages and
hash-verified Python wheels, clones Git repositories, publishes artifacts to explicitly
configured target registries, and can push Git mirrors into Gitea.

Treat transfer bundles and configured source repositories as trusted input. In
particular, `airgap-sync verify install` runs real package-manager install
commands for target projects. By default those installs may execute npm, pnpm, or
Yarn lifecycle scripts from the project or its dependencies. Use
`--ignore-scripts` when you only want to verify dependency resolution against the
closed-network services.

Python application health checks run only during explicit install verification and
inside its temporary environment, but a workspace recipe remains trusted executable
policy. Review custom recipes before use. Python collection is wheels-only and verifies
artifact identity and hashes; this protects transfer integrity, not against malicious
upstream package code. Generated locks are optional evidence. Completeness means that
each collected target brings its recursive dependency tree down to leaves for every
declared compatibility cell. It is tested with ordinary clients against an index
populated only from that bundle; it does not require consumers to follow an
`airgap-sync` lock or require airgap-sync to control all packages in the shared Gitea
owner. Consumer configuration should still avoid unintended public-index fallback.

The tool is designed to avoid storing credentials in workspace config files. Pass
Gitea tokens through `GITEA_TOKEN` where possible; command-line token arguments
can be visible through shell history and process listings.

`airgap-sync publish` pushes Git mirrors with mirror semantics. Use it only against
Gitea repositories that are intended to be managed as mirrors of the source
repositories.

See the [Python repository security review](./docs/python-application-security-review.md)
for detailed trust boundaries, failure recovery, and residual risks.

## Supported Versions

This project is pre-1.0. Security fixes are applied to the latest released version.

## Reporting a Vulnerability

Open a private security advisory on GitHub or contact the repository owner through
GitHub if a private report is needed.

Do not publish exploit details until a fix or mitigation is available.
