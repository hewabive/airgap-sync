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
policy. Review custom recipes before use. Generated Python consumer locks use exact
versions/hashes and wheels-only policy; this provides integrity and reproducibility,
not protection from malicious upstream package code.

The tool is designed to avoid storing credentials in workspace config files. Pass
Gitea tokens through `GITEA_TOKEN` where possible; command-line token arguments
can be visible through shell history and process listings.

`airgap-sync publish` pushes Git mirrors with mirror semantics. Use it only against
Gitea repositories that are intended to be managed as mirrors of the source
repositories.

See the [Python application security review](./docs/python-application-security-review.md)
for detailed trust boundaries, failure recovery, and residual risks.

## Supported Versions

This project is pre-1.0. Security fixes are applied to the latest released version.

## Reporting a Vulnerability

Open a private security advisory on GitHub or contact the repository owner through
GitHub if a private report is needed.

Do not publish exploit details until a fix or mitigation is available.
