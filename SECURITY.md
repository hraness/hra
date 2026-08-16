# Security policy

## Report a vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability
reporting](https://github.com/hraness/hra/security/advisories/new). Do not put
an exploit, secret, personal data, or other sensitive detail in a public issue
or discussion.

Include the affected commit or version, the component and configuration, steps
to reproduce the problem, its likely impact, and any known mitigation. Use
placeholder credentials and remove local paths, account identifiers, and
personal data from screenshots or logs.

If private vulnerability reporting is unavailable, open a public issue that
asks a maintainer to establish a private contact channel. Do not include
vulnerability details in that issue.

## Supported versions

Security fixes target the current `main` branch. When a published release is
affected, its advisory states which release versions receive a fix. Older
commits and unreleased development snapshots are not supported separately.

## Disclosure

Please allow maintainers time to investigate, reproduce, and prepare a fix
before public disclosure. Maintainers will coordinate disclosure through the
private advisory when the report is accepted.

The product trust boundaries and known limits are documented in
[SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).
