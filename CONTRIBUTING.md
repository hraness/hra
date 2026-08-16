# Contributing to HRA

HRA accepts focused bug fixes, tests, documentation, and product changes
through GitHub pull requests.

## Before you start

- Search existing issues and pull requests for overlapping work.
- Open an issue before a wide architectural change or a change to a durable
  protocol, cryptographic namespace, updater contract, or compatibility byte.
- Report suspected vulnerabilities through [SECURITY.md](SECURITY.md), not in a
  public issue.

## Set up the repository

Use Bun 1.3.14 and Node.js 24. Native desktop work also needs an Apple Silicon
Mac running macOS 13 or newer, Zig 0.16.0, Xcode Command Line Tools, and a macOS
SDK.

Install the checked dependency graph from the repository root:

```sh
bun install --frozen-lockfile
```

Read the closest `AGENTS.md` before changing a workspace. It defines that
directory's boundaries and required checks.

## Make a change

- Keep the change scoped to one clear outcome.
- Add deterministic regression coverage for behavior changes. Use property
  tests for parsers, state transitions, ordering, serialization, and other
  laws.
- Parse foreign values from `unknown`, and represent state so invalid states
  cannot be constructed.
- Treat persisted identifiers, cryptographic namespaces, updater contracts,
  and Keychain services as explicit protocol decisions. HRA is prerelease, so
  a deliberate breaking change is acceptable when its storage and recovery
  effects are covered by deterministic tests.
- Update documentation and third-party notices when behavior, setup, bundled
  source, fonts, artwork, or runtime dependencies change.
- Do not commit credentials, account identifiers, provider session data,
  transcripts, local paths, generated secrets, or build output.

## Verify a change

Run the narrowest relevant test while editing. Before opening a pull request,
run:

```sh
bun run check
```

Run the complete source and production-build gate for build, packaging, shared
configuration, or cross-workspace changes:

```sh
bun run check:complete
```

On a supported Mac, run native checks when the desktop host, native manifest,
or host boundary changes:

```sh
bun run --cwd apps/desktop test:macos
bun run --cwd apps/desktop build:macos
```

If a required check cannot run in your environment, name that check and the
reason in the pull request.

## Open a pull request

Describe the problem, the chosen behavior, and the evidence that verifies it.
Keep unrelated formatting or refactors out of the change. Link the relevant
issue and call out compatibility, security, migration, or platform effects.

All submitted contributions are subject to Section 5 of the
[Apache License 2.0](LICENSE). Unless you explicitly state otherwise, an
intentional contribution submitted for inclusion in HRA is provided under that
license without additional terms.
