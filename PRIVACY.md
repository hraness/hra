# Privacy

This policy describes the HRA v0.1 beta data boundary. The hosted sync service is beta-not-yet-live.

Cloud sync is optional. Local account profiles, Codex credentials, and local execution continue to work without it. HRA identity is separate from every Codex account.

## Encrypted before upload

- User messages and final assistant display text.
- Session names, notes, queued messages, and steering input.
- Turn timing, observed model and tier, and provider usage summaries.
- Bounded observed file and Git metadata, without unbounded filesystem paths.
- Remote-command input and results that fit the closed command protocol.

## Never uploaded

- Codex credentials, profile files, plugin credentials, or OAuth material.
- Raw app-server requests or responses.
- Raw reasoning, hidden chain of thought, or approval secrets.
- Environment variables, arbitrary command output, or unbounded filesystem paths.

The sync service necessarily sees the verified HRA email address, device identifiers, record types, revisions, ciphertext sizes, timestamps, and execution-lease or command lifecycle metadata. It cannot decrypt session content without a paired device key. Email access alone does not recover that key.

Compact-projection recovery is append-only. It preserves every older encrypted cloud chunk, opens a new stream epoch, and keeps the acknowledged unsynced interval visible as a recovery gap until authenticated account deletion.

The website uses no analytics, cookies, remote fonts, or executable JavaScript. Codex activity remains subject to OpenAI's own service and privacy terms.

> **Hosted sync status.** The hosted sync endpoint is beta-not-yet-live. Authenticated account deletion and capability-only progress recovery are implemented and pass deterministic hostile tests. Fresh-deployment and live completion acceptance remain launch gates.

Report a suspected boundary violation through [private vulnerability reporting](https://github.com/hraness/hra/security/advisories/new).
