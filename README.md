# HRA

[![HRA](https://hra.sh/opengraph-image)](https://hra.sh)

**A metaharness for Codex.** HRA turns the Codex accounts you already use into
one durable system for planning work, delegating it, running it in parallel,
and bringing it back for review.

[Download for macOS](https://hra.sh/download) · [Website](https://hra.sh) ·
[Compare HRA](https://hra.sh/alternatives) · [Open HRA](https://hra.sh/app)

> HRA 0.1.10 build 11 is a source release candidate for Apple Silicon Macs.
> Direct downloads remain disabled until its exact source commit, annotated
> tag, runtime tree, manifest, checksum, and artifact hashes are published. The
> candidate uses an ad-hoc code seal; it is not Developer ID signed or notarized.

## Why HRA exists

Codex can already run several agents in parallel. HRA handles what happens
between those sessions: which work belongs together, which account may run it,
what a child task owes its parent, how a follow-up keeps continuity, and what to
do after a process stops at an uncertain moment.

HRA adds five things:

- **Several authorized accounts, kept separate.** Pair Codex accounts you own
  or are allowed to use without merging their credentials or provider sessions.
- **A durable task graph.** Parent work, bounded children, dependencies,
  ownership, questions, submissions, and review survive any one agent window.
- **Work-aware routing.** Wide work gets more reasoning room; bounded work can
  use a lighter lane; safe follow-ups stay on their owned conversation.
- **Recovery with evidence.** Durable receipts distinguish work that happened,
  work that did not, and work that must be contained instead of guessed or
  replayed.
- **Local execution authority.** Repositories, commands, raw transcripts,
  provider sessions, and Codex credentials stay on the paired Mac.

HRA does not combine subscriptions or bypass provider limits. Every account
remains subject to its own plan, organization policy, and
[OpenAI terms](https://openai.com/policies/terms-of-use/). Only group accounts
that are authorized for the same repository and data.

## Is HRA the right tool?

Choose HRA when one project needs several coordinated Codex sessions and the
coordination itself must be durable. The first-party Codex app is usually the
better starting point for a few independent sessions. A multi-provider IDE or
worktree manager may be a better fit when model choice or workspace isolation
is the main problem, and a remote client may be better when the main job is
checking an agent from your phone.

The [comparison pages](https://hra.sh/alternatives) explain those tradeoffs
using current first-party sources, including Codex app, OpenCode Desktop,
Paseo, Conductor, Superset, OpenChamber, and Happy Coder.

## How it works

The web control plane keeps bounded task and review state. The paired desktop
app keeps Codex account custody and runs work inside managed Git worktrees. A
renewable lease and generation-bound fences prevent an old runner or stale
claim from continuing to mutate task state.

```text
one outcome
    │
    ├── durable root task ──┬── bounded child
    │                      └── bounded child
    │
    └── review, recovery, and continuation
             │
             └── authorized Codex accounts on the paired Mac
```

See [Security architecture](SECURITY_ARCHITECTURE.md) for the complete trust
and data boundary.

## Install the prerelease

The native app targets Apple Silicon and macOS 13 or newer. The
[download page](https://hra.sh/download) exposes no draft asset while the
checked release contract is a candidate. After publication, download the DMG
and checksum from that page, verify the SHA-256, and follow the
unknown-developer instructions. You can build the candidate source locally.

## Develop HRA

Repository development uses Bun 1.3.14 and Node.js 24. Native work additionally
requires Zig 0.16.0, Xcode Command Line Tools, and an Apple Silicon Mac.

```sh
bun install --frozen-lockfile
bun hra
```

Start the web control plane and its Convex development process with:

```sh
bun run web:hra
```

The web workspace needs a local Convex project before its first run. See the
[web guide](apps/web/README.md), [desktop guide](apps/desktop/README.md), and
[`taskctl` guide](apps/cli/README.md) for setup and architecture details.

## Verify a change

```sh
bun run check
bun run check:complete
```

On a supported Mac, also run:

```sh
bun run --cwd apps/desktop test:macos
bun run --cwd apps/desktop build:macos
bun run --cwd apps/desktop package:macos:adhoc
```

The package command creates the self-contained DMG and checksum under
`apps/desktop/zig-out/release/macos/arm64`. The full release command and its
corresponding-source artifacts are documented in the
[desktop guide](apps/desktop/README.md#verification).

## Project and license

HRA is under active development. It is an independent project and is not
affiliated with, endorsed by, or sponsored by OpenAI. “OpenAI” and “Codex” are
used only to identify the product HRA interoperates with.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report a
suspected vulnerability through [SECURITY.md](SECURITY.md), not a public issue.
HRA-authored source is licensed under [Apache License 2.0](LICENSE). Bundled and
vendored components retain their own terms in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). See
[TRADEMARKS.md](TRADEMARKS.md) for mark use.
