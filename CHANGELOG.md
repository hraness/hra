# Changelog

Every entry names the release or the plan wave it belongs to. Unreleased work sits under the wave that produced it until a version ships.

## v0.2.0

HRA v2 wave 0. Admitted 2026-09-03 as immutable GitHub Release `v0.2.0` and npm `latest`.

Robustness and security:

- The local daemon transport partitions its 32 connection slots into 16 for commands and 16 for long polls, answers an exhausted pool with a closed `UNAVAILABLE` failure instead of an indeterminate close, and bounds frame receipt and idle drain with separate timeouts. `hra daemon status --json` reports slot occupancy.
- Read-only opens such as `hra status` no longer run a full foreign-key scan, and the queue secure-delete checkpoint retries with backoff before it can stop the daemon.
- `account login-cancel` is recorded in the mutation ledger before dispatch and reconciled from the account read after a restart. A determinate provider rejection during daemon fence loss is recorded as failed rather than stranded.
- The usage poller and background schedulers surface closed diagnostics instead of failing silently; the daemon publishes a failed receipt on an unhandled rejection.
- One-time login codes are compared in constant time. The daemon and the session-note editor receive an allowlisted environment. Convex response bodies are byte-bounded. Each account key version has an AES-GCM message budget that fails closed with `KEY_ROTATION_REQUIRED`. Redaction covers more unlabelled secret shapes.
- A per-directory import boundary lint enforces the domain to storage to daemon to adapter layering, and a check refuses file-level import cycles under `src/`.

CLI:

- `hra --json work protocol` works before `hra init` and without a daemon.
- `hra help [group [command]]` and leaf-level `--help`; `--json` output for `help` and `version`; an unhealthy `doctor` result now returns `ok: false` with `error.code: "UNHEALTHY"` alongside its data.

Release and site:

- `bun run install-pins:update` re-pins the installer's embedded CLI and normalizer digests between releases; the public command's digest is proven against the tagged runtime in the tag workflow instead of against the working tree.
- One `CODEX_PIN` constant and `bun run codex:bump` replace scattered Codex version literals; the account usage digest domain no longer changes when the pin changes.
- Retired release scripts are deleted, duplicate CI steps are removed, and the tag workflow reads back the tagged commit's successful CI run instead of rerunning the gate.
- The README leads with a thesis and badges, the social card is a build-time PNG, and public copy is checked for em dashes.

Plan:

- `kb/plans/hra-v2.md` proposes the provider-neutral, swarm-coordination, web-surface, and documentation plan; `kb/notes/web-ux.md` holds the browser UX contract.

## v0.1.6

The first admitted public local CLI release. See `docs/beta-release-notes.md`.
