# Contents

- `SKILL.md` – routing, safety boundaries, and the local operating model.
- `scripts/` – deterministic bootstrap, scheduling, capability-lane, telemetry, CI-ref, validation, audit, and cleanup commands.
- `assets/` – managed global guidance, model profiles, and repository policy templates.
- `agents/openai.yaml` – Codex discovery and invocation metadata.

# Guidelines

- Keep the skill local-only and preserve useful agent fan-out.
- Keep scripts standalone from HRA product packages except for the explicitly resolved, immutable Atet host-resource runtime.
- Keep throughput telemetry private, bounded, path-free, and separate from Atet's scheduler state. Telemetry failure must never change a child command result.
- Default audits to read-only. Require exact paths for worktree removal and preserve every repository final gate.
- Test mutations in temporary fixtures. Never let tests write real global Codex state, repositories, or plugin configuration.
- Keep bootstrap changes marker-bounded and idempotent; preserve unmanaged user configuration byte-for-byte.
