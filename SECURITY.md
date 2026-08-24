# Security

HRA coordinates local Codex accounts and can control active coding sessions. Treat a vulnerability that crosses an account, device, process generation, filesystem root, or execution lease as security-sensitive.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. Include the affected version, platform, reproduction steps, expected boundary, observed result, and whether credentials or provider mutations were exposed.

## Supported versions

Until the first stable release, only the latest published beta receives security fixes.

## Product boundary

HRA does not sync Codex credentials, raw reasoning, approval secrets, environment values, or arbitrary tool output. Cloud commands do not bypass local Codex permissions. Account switching is explicit and never used to evade provider limits.

The CLI stores HRA's revocable device credential, workspace encryption key, and local signing authority as immutable generations below its private state root. Custody directories must be owned by the current user with mode 0700. Value files must be single-link mode-0600 regular files and are read through bounded no-follow descriptors. The detached Bun daemon never opens a Keychain prompt. HRA forces both pinned Codex credential stores to file mode and verifies their effective settings, so Codex credentials remain separately owned by each profile's isolated `CODEX_HOME`.
