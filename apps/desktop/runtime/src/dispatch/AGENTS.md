# Contents

- `activity-adapter.ts` – fenced Codex phase, public display-stream, and anonymous tool-activity projection into the durable outbox.
- `interaction-adapter.ts` – fenced, fair safe-request sync, boot-key response opening, exact expiry settlement, and acknowledgement without answer persistence.
- `coordinator.ts` – restart-safe local orchestration across claim fences, Git, and Codex.
- `cloud-client.ts` – bounded outbound HTTP transport for runner heartbeat, dispatch claims, and semantic event replay.
- `local-capabilities.ts` – signed-in-account capacity, repository binding, and per-account reservations.
- `model.ts` – closed dispatch lifecycle, public event vocabulary, and transition laws.
- `pairing.ts` – strict taskctl profile, session, keychain, and repository-mapping discovery.
- `revocation.ts` – fail-closed stop, interrupt, lease-loss, interaction-limit failure, and local-capacity release coordination.
- `runner.ts` – supervised heartbeat, pull, lease, capacity, shutdown, and durable-outbox coordination.
- `session-launcher.ts` – inspect-before-retry managed-worktree thread and turn adapter.

# Guidelines

- Keep cloud-visible dispatch state bounded and semantic. Never include prompts, raw reasoning, command output, environment values, credentials, provider identifiers, or local filesystem paths.
- The only cloud-visible Codex text is the bounded reasoning-summary and assistant-message delta channels. Collapse all tool items into content-free active/inactive activity; never forward tool names, IDs, arguments, commands, output, or paths.
- Treat the cloud claim fence and the local boot/run binding as one authorization tuple. A stale tuple may stop local work but may not publish task progress or completion.
- Model ambiguous Git and Codex mutations explicitly. Inspect and reconcile before retrying an external side effect.
- Recover only a complete managed-worktree identity. A historical binding with no managed lane and branch is a retired execution mode; mark it ambiguous for human attention before any Git or Codex side effect and never convert it during restart.
- Permit plaintext HTTP only for exact loopback development origins. Require HTTPS for every remote control-plane origin, disable redirects, and keep credentials out of errors and diagnostics.
- Advance heartbeat generations only after a validated response. Treat an indeterminate response as read-only on replay and do not infer a renewed dispatch lease from it.
- Report cancellation only after proving that no Codex turn exists or interrupting the owned turn. Preserve ambiguous work and capacity when proof is unavailable.
- Keep taskctl pairing optional for desktop startup. Invalid dispatch configuration may leave web readiness offline but must not disable the local account/session dashboard.
- Treat interaction-limit failure as terminal for only its owning run. Interrupt it, publish the durable failure, and release its capacity without halting the singleton runner.
- Close any durable anonymous tool span before appending a terminal run event. Terminal lifecycle and activity callbacks may race, so correctness must not depend on callback timing.
- Keep stable public event kinds mode-neutral in presentation. The `worktree.preparing` and `worktree.ready` summaries describe an execution workspace rather than exposing storage details.
