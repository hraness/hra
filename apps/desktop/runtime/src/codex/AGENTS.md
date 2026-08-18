# Contents

- `jsonl.ts` – bounded incremental UTF-8 JSONL decoding.
- `envelope.ts` – strict Codex JSON-RPC envelope classification from `unknown`.
- `writer.ts` – the single serialized JSONL writer for one process generation.
- `rpc-core.ts` – private generation-scoped JSON-RPC correlation, monotonic envelope positions, and inbound method dispatch.
- `pinned-codecs.ts` – generated-backed 0.144.6 request, response, notification, and server-request associations plus bounded owned runtime codecs.
- `pinned-protocol.ts` – the closed operation registry, request policy, parsed callback surface, and sole owner of raw transport calls.
- `production-execution-policy.ts` – immutable full-access production policy, managed-requirements preflight proof, and exact-generation thread and turn admission receipts.
- `dynamic-tool.ts` – the disabled-by-default, exact-`0.144.6`-probe-witnessed lexical RLM v2 callback contract, bounds, caller identity, and generation-local replay ledger.
- `safe-display.ts` – terminal-safe, UTF-8-byte-bounded owned display prose.
- `facts.ts` – the closed positioned HRA fact vocabulary and aggregate fact bound.
- `fact-projector.ts` – the only strict parsed-notification and positioned-response projection into owned facts.
- `fact-router.ts` – one notification projection and explicit immutable fan-out to account and session consumers.
- `compatibility-0-144-6.ts` – exact version-specific remote-error classification with bounded provider-text inspection.
- `supervisor.ts` – bounded process restart sequencing, caller-supplied durable generation floors, and capped backoff.
- `index.ts` – the owned provider-adapter API exposed to the rest of the gateway.

# Guidelines

- Keep generated Codex types and raw protocol payloads inside this directory; expose only owned discriminated adapter types.
- Associate every used operation and routed inbound payload with the pinned generated types, and make method-set drift fail compilation.
- Keep timeout, concurrency, lost-response, effect, and reconciliation policy in the closed operation registry. Do not accept these policies from callers.
- Preflight `configRequirements/read` in the exact runtime generation before every production thread or turn mutation. Require `approvalPolicy: never`, `approvalsReviewer: auto_review`, and danger-full-access at both thread and turn boundaries; fail before mutation when managed requirements exclude any field.
- Parse and verify returned thread admission settings against the immutable production policy. Never downgrade, infer support from a partial response, or mint an admission receipt across generations.
- Keep `CodexRpcCore` private to this directory. Code above the pinned protocol uses owned operation keys and parsed outputs only.
- Parse bytes and foreign values from `unknown`, and report diagnostics with bounded method names and reason codes rather than payloads.
- Project each accepted parsed notification exactly once. A malformed supported value or failed fact consumer is a generation-ending protocol fault; never retry another consumer as a fallback.
- Inspect bounded remote error text only at ingress to derive an owned classification, then discard it; never retain or project provider messages or response data.
- Scope request and server-request authority to one monotonic process generation and HRA-owned request instance. Bound provider request IDs, admit each provider request ID at most once per generation, cap active and total server requests, and expire them when that generation ends.
- Run the caller's durable-generation persistence hook before publishing `starting` or creating every replacement process; never reuse a generation across whole-app restarts.
- Serialize every stdin write and never automatically replay a request after a transport fault, timeout, or restart.
- Admit only witnessed v1 operations: completed-prefix/current-input context reads, `thread/start` actor incarnations, idle-boundary `turn/start` follow-ups, and receipt-backed status, waits, result, and cancellation. Reject `thread/fork`, `turn/steer`, goals, and all non-v1 harness operations.
- Assign one safe monotonic stream position to each accepted current-generation envelope before dispatch and to each successfully written server-request response. Do not position stale, malformed, failed, or expired work.
- Reject an owned fact before fan-out when its encoded form exceeds the shared eight-MiB aggregate bound. Keep each retained display field within its smaller semantic bound.
- Use the typed positioned-response API for hydration watermarks. Do not expose raw responses or transport request IDs.
- Treat unsupported server requests as expired after returning JSON-RPC method-not-found; never leave app-server waiting on an unknown callback.
