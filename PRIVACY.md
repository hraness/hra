# Privacy

This policy describes the HRA v0.1 beta data boundary. The hosted sync service is beta-not-yet-live.

Cloud sync is optional. Local account profiles, Codex credentials, and local execution continue to work without it. HRA identity is separate from every Codex account.

## Encrypted before upload

- User messages and final assistant display text.
- Session names, notes, queued messages, and steering input.
- Codex account labels and observed provider email and plan metadata when cloud sync is enabled.
- Turn timing, observed model and tier, and provider usage summaries.
- Bounded observed file and Git metadata, without unbounded filesystem paths.
- Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.
- Remote-command input and results that fit the closed command protocol.

## Never uploaded

- Codex credentials, profile files, plugin credentials, or OAuth material.
- Raw app-server requests or responses.
- Raw reasoning, hidden chain of thought, or approval secrets.
- Provider login and request IDs, permission values, MCP field contracts, protected answers, or response digests.
- Environment variables, arbitrary command output, or unbounded filesystem paths.

The sync service necessarily sees the verified HRA email address, device identifiers, record types, revisions, ciphertext sizes, timestamps, and execution-lease or command lifecycle metadata. It cannot decrypt session content without a paired device key. Email access alone does not recover that key.

Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked.

Compact-projection recovery is append-only. It preserves every older encrypted cloud chunk, opens a new stream epoch, and keeps the acknowledged unsynced interval visible as a recovery gap until authenticated account deletion.

The website uses no analytics, cookies, remote fonts, or executable JavaScript. Codex activity remains subject to OpenAI's own service and privacy terms.

> **Hosted sync status.** The hosted sync endpoint is beta-not-yet-live. Authenticated account deletion and capability-only progress recovery are implemented and pass deterministic hostile tests. Fresh-deployment and live completion acceptance remain launch gates.

Report a suspected boundary violation through [private vulnerability reporting](https://github.com/hraness/hra/security/advisories/new).
