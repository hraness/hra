# Contents

- `src/` – argument parsing, profile custody, HTTP transport, and command rendering.
- `scripts/` – deterministic standalone release, verification, and installer-generation tooling.
- `README.md` – human and agent authentication, selection, and lifecycle command usage.
- `package.json` – the `@hraness/hra-cli` workspace and `taskctl` source, test, typecheck, and standalone build commands.
- `tsconfig.json` – strict Bun CLI TypeScript configuration.

# Guidelines

- Keep commands non-interactive whenever stdin is not a TTY and make `--json` output a stable machine contract.
- Write selected data to stdout and diagnostics to stderr; agents branch on error codes, never prose.
- Never place enrollment secrets, refresh tokens, agent bearer tokens, or session credentials in argv, stdout, logs, or non-secret profile metadata.
- Prefer the operating-system keychain and use a mode-`0600` file only as the documented fallback.
- Keep the CLI an HTTP client. Domain authorization and state transitions belong in Convex.
- Treat the locally selected organization and workspace as authoritative; administration commands must not accept tenant-selector overrides.
- Generate enrollment material locally and write it only to a new explicit absolute mode-`0600` output path.
- Keep release manifests closed and checksummed; installation verifies a single platform artifact before an atomic, explicit-destination replacement.
