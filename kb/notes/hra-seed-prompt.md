---
title: HRA seed prompt
description: The written product seed for a minimal multi-account Codex CLI.
type: note
status: current
area: hra
tags:
  - cli
  - codex
  - product
relations:
  related-to: [ plans/hra-v1 ]
---

# HRA seed prompt

Build a new public project at `hraness/hot-codex` for `hotcodex.com`. Keep the product radically small: one Bun CLI, one headless local daemon, one Convex cloud service, and a static documentation website. There is no product UI.

The CLI should let me sign in to several Codex subscriptions on one machine. Give every subscription an isolated, user-only Codex profile. Track provider usage and rate-limit observations locally, then sync an encrypted bounded projection to my Hot Codex account. Hot Codex identity uses an email verification code and remains separate from every Codex subscription.

Add an explicit macOS command that switches the account used by the supported ChatGPT/Codex desktop application. It should gracefully quit the exact application process, select the requested isolated profile through a verified full-profile launch boundary, relaunch once, and verify the account attached to that launched instance. Journal the effect, use one machine-global lock, and fail closed after an uncertain quit, launch, or verification. Never copy `auth.json`, swap one token, modify Keychain blindly, or rotate accounts to evade a provider limit.

Make sessions useful from the terminal. I need commands to list, start, read, send, queue, steer, stop, rename, and inspect sessions; to set or edit one note per session; and to change the project directory, model preset, and Fast mode for future turns. The default view should show bounded user and final assistant messages with turn runtime and safe observed file or Git-action metadata. A separate turn command can show bounded provider-visible detail, but never hidden reasoning.

Use a small recommended preset surface:

- `low`: Luna with maximum supported reasoning.
- `high`: Sol with maximum supported reasoning.
- `ultra`: Sol with Ultra reasoning effort.
- Fast: an explicit `on` or `off` overlay resolved against the current account.

Resolve exact models, efforts, service tiers, permission profiles, plugins, and tools from the active Codex generation. Fail before an effect when a requested capability is unavailable. The recommended policy uses Codex's advertised automatic review path, the canonical Documents directory as the initial project, supported computer use, and already-installed plugins. Do not install plugins, accept OAuth, widen plugin permissions, or implement a blanket unknown-request approval callback.

Support several enrolled machines under one Hot Codex account. Sync only client-side encrypted session metadata, compact messages, notes, bounded usage, timing, and safe observed file or Git metadata. Never upload Codex credentials, provider profile files, raw app-server traffic, environment variables, raw command output, approval secrets, or hidden reasoning. A session remains attached to its origin machine in v1. Other devices can read synced projections and enqueue encrypted commands for that machine, but they cannot silently take over its provider thread.

Keep remote effects idempotent and fenced. One device and daemon generation owns the execution lease. Durable command state must distinguish preparation, effect start, success, known failure, and ambiguity. A crash or lost response after effect start is never blindly replayed.

Publish a minimal website whose content matches the repository README. Lead with the real install command, then explain setup, accounts, presets, desktop switching, sessions, cloud sync, privacy, and the command reference. Launch without analytics, cookies, remote fonts, or client JavaScript.

Carry forward the engineering conventions that earned their keep: strict foreign parsing, closed protocols, append-only migrations, property tests plus named regressions, stdout-as-data and stderr-as-diagnostics, stable `--json`, scoped `AGENTS.md` files, direct public writing, a durable KB, pinned dependencies, standalone clean-consumer gates, and unreasonably robust programming where failure could duplicate an external effect or cross an authority boundary.

This note preserves the original Hot Codex seed as historical product provenance. The product is now HRA, and its expanded implementation and migration contract is [HRA v1](../plans/hra-v1.md).
