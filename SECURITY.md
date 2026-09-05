# Security

HRA coordinates local Codex and Claude Code profiles and can control active provider sessions. Treat a vulnerability that crosses an account, provider, device, process generation, filesystem root, or execution lease as security-sensitive.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. Include the affected version, platform, reproduction steps, expected boundary, observed result, and whether credentials or provider mutations were exposed.

## Supported versions

| Version | Status |
| --- | --- |
| `v0.5.0` | Supported beta. Receives security fixes. |
| `v0.4.1` | Historical immutable beta. Upgrade to `v0.5.0`. |
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

Facts-memory authority is host-derived from one exact account and session. Agent commands cannot select its store, directory, authority, rule set, or purge capability. HRA persists only opaque hashes, exact public heads and receipts, lifecycle state, and expiry metadata. Release-verified public Oh v0.2.7 remains the semantic authority behind a narrow broker port; `package.json` and `bun.lock` bind that exact immutable npm release.

The local Oh adapter confines each store to one canonical current-user-owned mode-0700 session directory outside HRA's lifecycle SQLite. It enforces and reads back mode 0600 on the main SQLite file, observed WAL and SHM files, and its no-follow metadata sidecar. Cleanup quiesces the store, rejects links and path escape, revalidates the bounded tree, renames the whole directory to a host-derived quarantine, and removes that quarantine before committing a purge receipt. These path checks protect against accidental and cross-boundary traversal. They do not sandbox another process running as the same operating-system user, and they do not erase backups or filesystem snapshots.
