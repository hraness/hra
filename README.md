# HRA

[![HRA](https://hra.sh/opengraph-image)](https://hra.sh)

HRA is the tokenmaxxing metaharness for Codex. It coordinates durable,
parallel Codex work across multiple accounts so a human can plan, supervise,
review, and recover long-running project work.

[Website](https://hra.sh) · [Build for macOS](https://hra.sh/download) ·
[Open HRA](https://hra.sh/app)

HRA is an independent project. It is not affiliated with, endorsed by, or
sponsored by OpenAI. “OpenAI” and “Codex” are used only to identify the product
that HRA interoperates with.

## What HRA does

- Keeps tasks, dependencies, claims, leases, submissions, reviews, and recovery
  durable across agent processes.
- Routes work across eligible Codex accounts while enforcing bounded local
  capacity and account isolation.
- Runs repository work in managed Git worktrees on a paired Mac.
- Keeps Codex credentials, provider sessions, raw transcripts, tool details,
  commands, output, and canonical filesystem paths on that Mac.
- Gives the browser a bounded task and supervision view without making it an
  authority for local execution.
- Supports an optional encrypted, summary-only session directory for viewing
  bounded session state on another approved device.

HRA is under active development. The desktop application supports Apple
Silicon Macs running macOS 13 or newer.

## Repository map

- [`apps/desktop`](apps/desktop) contains the native macOS host, local gateway,
  Codex account connections, chat panes, runner, and local state.
- [`apps/web`](apps/web) contains the Next.js task control plane, Convex
  functions, WorkOS authentication boundary, and deterministic browser lab.
- [`apps/cli`](apps/cli) contains `taskctl`, the versioned command-line client
  for human and agent task operations.
- [`packages`](packages) contains shared task contracts, client code, interface
  components, and repository tooling.

The web control plane owns task and review state. The paired desktop runner
claims eligible work over outbound HTTPS, provisions a managed worktree, and
starts the corresponding Codex session locally. A renewable lease and
generation-bound fences prevent an old runner or stale claim from continuing
to mutate task state.

See [Security architecture](SECURITY_ARCHITECTURE.md) for the trust boundaries
and data-handling model.

## Requirements

Repository development uses:

- Bun 1.3.14
- Node.js 24
- Apple Silicon macOS 13 or newer for the desktop host and native tests
- Zig 0.16.0, Xcode Command Line Tools, and a macOS SDK for native builds

Install the exact dependency graph from the repository root:

```sh
bun install --frozen-lockfile
```

## Develop HRA

Start the desktop application:

```sh
bun hra
```

Start the web control plane and its Convex development process:

```sh
bun run web:hra
```

The web workspace needs a local Convex project before its first run. Follow
[`apps/web/README.md`](apps/web/README.md) for environment setup. See
[`apps/desktop/README.md`](apps/desktop/README.md) for account connection,
runner pairing, local data, and native development. See
[`apps/cli/README.md`](apps/cli/README.md) for `taskctl` authentication and
commands.

## Verify a change

Run the repository source gate:

```sh
bun run check
```

Run source checks and production builds:

```sh
bun run check:complete
```

On a supported Mac, verify the native host separately:

```sh
bun run --cwd apps/desktop test:macos
bun run --cwd apps/desktop build:macos
```

Focused workspace checks are documented in each workspace README and
`package.json`.

## Contribute and report security issues

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report a
suspected vulnerability through the private process in [SECURITY.md](SECURITY.md),
not through a public issue.

HRA-authored source is licensed under the [Apache License 2.0](LICENSE).
Bundled and vendored components retain their own licenses and notices, listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The source license does not
grant trademark rights; see [TRADEMARKS.md](TRADEMARKS.md).
