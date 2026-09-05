# Contents

- `SKILL.md` – routing, safety boundaries, and the local operating model.
- `scripts/` – deterministic Codex/Claude bootstrap, repository adoption, scheduling, capability-lane, telemetry, CI-ref, validation, audit, and cleanup commands.
- `assets/` – managed Codex and Claude global guidance, model profiles, and repository policy templates.
- `agents/openai.yaml` – Codex discovery and invocation metadata.

# Guidelines

- Keep the skill local-only and preserve useful agent fan-out.
- Keep scripts standalone from HRA product packages except for the explicitly resolved, immutable Atet host-resource runtime.
- Keep throughput telemetry private, bounded, path-free, and separate from Atet's scheduler state. Telemetry failure must never change a child command result.
- Default audits to read-only. Require exact paths for worktree removal and preserve every repository final gate.
- Test mutations in temporary fixtures. Never let tests write real global Codex state, repositories, or plugin configuration.
- Keep bootstrap changes marker-bounded or exact-key-scoped and idempotent; preserve unrelated user configuration byte-for-byte and preflight every target before mutation.
