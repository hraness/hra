# Security

HRA coordinates local Codex accounts and can control active coding sessions. Treat a vulnerability that crosses an account, device, process generation, filesystem root, or execution lease as security-sensitive.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. Include the affected version, platform, reproduction steps, expected boundary, observed result, and whether credentials or provider mutations were exposed.

## Supported versions

Until the first stable release, only the latest published beta receives security fixes.

## Product boundary

HRA does not sync Codex credentials, raw reasoning, approval secrets, environment values, or arbitrary tool output. Cloud commands do not bypass local Codex permissions. Account switching is explicit and never used to evade provider limits.
