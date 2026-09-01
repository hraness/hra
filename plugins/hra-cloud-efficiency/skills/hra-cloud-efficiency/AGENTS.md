# Contents

- `SKILL.md` contains routing, safety boundaries, and the Codex Cloud repository-worker workflow.
- `scripts/` contains deterministic bootstrap, route qualification, private CLI launch, doctor, and repository-adoption commands.
- `references/` contains conditional environment-profile and Cloud lifecycle guidance.
- `assets/` contains marker-bounded global and repository policy.
- `agents/openai.yaml` contains Codex discovery and invocation metadata.

# Guidelines

- Keep the root coordinator and integration owner on the caller-selected model. Never claim that Cloud inherited a model or reasoning setting.
- Keep routing read-only and classified. Actual task creation must remain a visible official `codex cloud exec` effect.
- Never route authenticated browser, 2FA, Mac-native, signing, release, deployment, private local data, uncommitted input, or agent-phase secret work to Cloud.
- Keep HRA hosted and Convex operations out of this skill. Use `hra-local-efficiency` for local scheduling and maintenance.
- Keep the launch guard limited to an exact official CLI invocation, prompt stdin, private temporary cwd, signal forwarding, and exact scratch cleanup. Never parse private provider responses or retry a failed task submission automatically.
- Never persist prompt text, provider output, account identifiers, environment identifiers, task identifiers, or absolute repository paths in routing reports.
- Test mutations in temporary fixtures. Never let tests write real global Codex state, repositories, plugin configuration, or remote tasks.
- Keep bootstrap and adoption changes marker-bounded and idempotent. Preserve unmanaged user configuration byte-for-byte.
