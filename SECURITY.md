# Security

HRA coordinates Codex accounts on macOS and Linux and Claude accounts on Linux, and it can control active coding sessions on those supported provider surfaces. Treat a vulnerability that crosses a provider, account, device, process generation, filesystem root, or execution lease as security-sensitive.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. Include the affected version, platform, reproduction steps, expected boundary, observed result, and whether credentials or provider mutations were exposed.

## Supported versions

| Version | Status |
| --- | --- |
| `v0.6.0` | Release candidate. Supported once the release workflow admits it. |
| `v0.5.0` | Supported beta until `v0.6.0` is admitted. Receives security fixes. |
| `v0.4.1` | Superseded by `v0.5.0`. Unsupported. |
| `v0.4.0` | Superseded by `v0.4.1`. Unsupported. |
| `v0.3.0` | Superseded by `v0.4.0`. Unsupported. |
| `v0.2.1` | Superseded by `v0.3.0`. Unsupported. |
| `v0.2.0` | Superseded by `v0.2.1`. Unsupported. |
| `v0.1.6` | Superseded by `v0.2.0`. Unsupported. |
| `v0.1.0` through `v0.1.5` | Unsupported. These tags produced no admitted npm package plus GitHub Release pair; `docs/beta-release.md` records each outcome. |

Only the latest published beta receives security fixes.

## Product boundary

HRA does not sync Codex or Claude Code credentials, provider profile files, raw reasoning, approval secrets, environment values, or arbitrary tool output. Cloud commands do not bypass local provider permissions. Account and provider switching is explicit and never used to evade provider limits.

The CLI stores HRA's revocable device credential, workspace encryption key, and local signing authority as immutable generations below its private state root. Custody directories must be owned by the current user with mode 0700. Value files must be single-link mode-0600 regular files and are read through bounded no-follow descriptors. The detached Bun daemon never opens a Keychain prompt. HRA forces both pinned Codex credential stores to file mode and verifies their effective settings, so Codex credentials remain separately owned by each profile's isolated `CODEX_HOME`. Claude Code receives that profile's isolated `CLAUDE_CONFIG_DIR`; HRA treats the whole directory as Claude Code's authentication boundary and never reads, copies, or forwards its credentials. Provider-managed system credential storage remains owned by the provider runtime.

Claude Code owns Claude authentication inside each profile's separate absolute `CLAUDE_CONFIG_DIR`. On Linux, the foreground login gives the exact pinned CLI the terminal descriptors directly. The status path bounds time and output, validates the pinned CLI's response, and exposes only `signedIn`. HRA never opens, copies, renders, or uploads a Claude credential. Claude login has no web, device-code, detached-handoff, or background-cancellation path. HRA refuses new Claude login, status-probe, session, and switch effects on macOS until authenticated testing proves isolated Keychain custody and detached-daemon reads without a prompt.

Codex web linking uses a versioned request for the provider's device-code mode. The HTTPS verification URL and separate user code are validated as one complete handoff, encrypted under the HRA account key, readable once by the requesting browser, and erased from the hosted row on that read. A hosted settlement deadline blocks release after five minutes even when the machine clock is wrong. Local account-linking opt-in, registry membership, requesting-device authority, and daily command limits all apply before the provider effect.

Facts-memory authority is host-derived from one exact account and session. Agent commands cannot select its store, directory, authority, rule set, or purge capability. HRA persists only opaque hashes, exact public heads and receipts, lifecycle state, and expiry metadata. Release-verified public Oh v0.2.7 remains the semantic authority behind a narrow broker port; `package.json` and `bun.lock` bind that exact immutable npm release.

The local Oh adapter confines each store to one canonical current-user-owned mode-0700 session directory outside HRA's lifecycle SQLite. It enforces and reads back mode 0600 on the main SQLite file, observed WAL and SHM files, and its no-follow metadata sidecar. Cleanup quiesces the store, rejects links and path escape, revalidates the bounded tree, renames the whole directory to a host-derived quarantine, and removes that quarantine before committing a purge receipt. These path checks protect against accidental and cross-boundary traversal. They do not sandbox another process running as the same operating-system user, and they do not erase backups or filesystem snapshots.
