# Contents

- Build scripts compile the CLI and generate the static website.
- Check scripts verify package contents, README parity, dependencies, and release metadata.

# Guidelines

- Keep scripts deterministic, noninteractive, and safe in a clean clone.
- Parse external command output from `unknown` and name every expected file.
- Do not read credentials, home-directory application state, or provider configuration during ordinary checks.
- A release script verifies; it does not infer permission to publish, deploy, tag, or mutate a provider.
