# Contents

- `index.ts` – the public protocol surface.
- `model.ts` – cloud-only scopes, roles, credential/session settings, WorkOS and tenant locators, UUID/request-correlated cloud events, and exact task-domain model re-exports.
- `errors.ts` – typed API errors, exit classes, and error-envelope parsing.
- `tokens.ts` – opaque token formatting, parsing, and redaction contracts.
- `http.ts` – fixed HTTP headers and versioned API route builders.
- `dispatch.ts` – runner heartbeat, repository capability, dispatch claim, semantic event, and realtime human-view contracts.
- `dispatch-identifiers.ts` – compatibility re-exports of task-domain runner, boot, claim, run, and event identifiers.
- `interactions.ts` – bounded, claim-fenced, response-body-free human-interaction sync and view contracts.
- `interaction-crypto.ts` – boot-scoped P-256/HKDF/AES-GCM response sealing, fixed padding, and authority-bound authenticated data.
- `human.ts` – strict human-auth, organization, workspace, and agent-administration wire contracts.
- `hra-human-wire.ts` – dedicated human-bearer HRA workspace reads, mutation intents, sealed HITL responses, invalidation polling, route builders, and route parsing.
- `session-sync.ts`, `session-sync-wire.ts`, and `session-sync-pairing.ts` – strict encrypted summary, membership, device-presence, directory snapshot/change, pairing, quota, and authenticated relay contracts.
- `session-sync-crypto.ts`, `session-sync-recovery.ts`, and `session-sync-recovery-crypto.ts` – non-extractable device custody, per-session AEAD, root wrapping/linking, one-use recovery authority, and retained-keyring validation.
- `promotion-wire.ts` – compact v2 promotion start, batch, lookup, decision, receipt-audit, and cleanup HTTP contracts.
- `wire.ts` – strict request and response validators for the HTTP boundary.
- `tasks.test.ts` and `tasks.property.test.ts` – complete work-graph boundary examples and parser laws.
- `*.test.ts` – deterministic boundary examples.
- `*.property.test.ts` – parser-totality and redaction laws.

# Guidelines

- Treat every parsed value as untrusted until its strict schema succeeds.
- Make invalid scope, state, actor, token, and error combinations unrepresentable with discriminated unions.
- Keep token parsing total and redact full matches without preserving credential identifiers.
- Keep human lifecycle views metadata-only: public locators and timestamps may cross the wire, but bearer verifiers and session authorization IDs may not.
- Keep HITL response plaintext out of every cloud wire shape. Seal only to a non-extractable boot key, authenticate the full authority tuple and request digest, and reject any digest or context mismatch before opening.
- Cloud-visible run display events may contain only bounded Codex reasoning-summary deltas, bounded assistant-message deltas, or content-free tool-activity state. Never add raw reasoning, commands, tool identity, arguments, output, provider IDs, or local paths to this boundary.
- Convert every shrunk property failure into a named example regression.
- Keep portable schema identity exact across the seam: compatibility modules re-export domain objects rather than maintaining parallel validators.
- Treat session summaries as the complete cloud-visible session payload. Reject nested or disguised content-bearing fields, keep ordinary Unicode display text usable, and expose device presence only as a current-member device ID plus `online`, `offline`, or `unknown`.
- A revoked-origin snapshot must retain its last accepted encrypted head under a strictly newer `offline` reset fence. Incremental reset and snapshot install must therefore converge without resurrecting write authority or discarding readable last-known state.
