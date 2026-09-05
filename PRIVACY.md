# Privacy

This policy describes the HRA beta data boundary. The hosted sync service is live as an open beta. Besides completed turns, the daemon streams the current turn's assistant text to the hosted service in encrypted, redacted batches that expire within six hours; reasoning summaries are included only when you enable show-thinking for a session, and raw reasoning is never uploaded.

Cloud sync is optional. Local provider profiles, Codex credentials, Claude Code configuration and credentials, and local execution continue to work without it. HRA identity is separate from every provider account.

## Encrypted before upload

- User messages and final assistant display text.
- Session names, notes, queued messages, and steering input.
- Codex account labels and observed provider email and plan metadata when cloud sync is enabled. Claude Code account identity and usage are not projected. HRA validates one bounded Claude Code authentication-status response transiently, reduces it to signedIn, and never retains, returns, projects, or uploads the identity or usage fields; it never opens or parses a Claude credential file.
- Turn timing, observed model and tier, and provider usage summaries.
- Bounded observed file and Git metadata, without unbounded filesystem paths.
- Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.
- Remote-command input and results that fit the closed command protocol.
- For an explicitly requested Codex web login, the provider HTTPS verification URL and separate one-time user code. HRA encrypts both to the account key before upload, lets only the requesting browser read them once, and deletes the hosted handoff on that read or after five minutes.

## Never uploaded

- Codex or Claude Code credentials, provider profile or configuration files, plugin credentials, OAuth access or refresh tokens, authorization codes, PKCE verifiers, provider cookies, or the private device code.
- Raw Codex app-server or Claude Code stream requests or responses.
- Raw reasoning, hidden chain of thought, or approval secrets.
- Provider-internal login and request IDs, permission values, MCP field contracts, protected answers, or response digests.
- Environment variables, arbitrary command output, or unbounded filesystem paths.

The sync service necessarily sees the verified HRA email address, device identifiers, record types, revisions, ciphertext sizes, timestamps, and execution-lease or command lifecycle metadata. It cannot decrypt session content without a paired device key. Email access alone does not recover that key.

A browser device holds the account key and decrypted projection only in that tab's memory by default. HRA does not programmatically write decrypted provider or session text to the clipboard, but browser extensions, accessibility APIs, screenshots, and explicit user selection can observe rendered text.

HRA uses Convex to authenticate the HRA identity and store server-visible metadata plus encrypted projections. Convex receives the verified email address and the service metadata described above, but not the keys required to decrypt session content.

HRA uses Resend to deliver verification email. Resend receives the recipient email address, sender identity, one-time verification code and message content, and ordinary delivery metadata. It receives no provider credentials or encrypted session projection.

HRA uses anonymous, cookieless PostHog analytics on the public hra.sh pages to count page views and page leaves and measure selected Web Vitals. Collection runs only on the canonical production host, honors Do Not Track, keeps its visitor identifier in memory, and disables person profiles, autocapture, heatmaps, feature flags, surveys, conversations, and session recording. PostHog receives the canonical route, bounded referral classification, browser performance measurements, a cookieless visitor identifier, and ordinary request metadata such as IP address, user agent, and time. HRA sends no form values, account identity, provider or session data, URL query, or fragment. Vercel serves hra.sh, and GitHub hosts the source repository, releases, and release downloads; those providers receive ordinary request metadata when visited.

Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked.

Compact-projection recovery is append-only. It preserves every older encrypted cloud chunk, opens a new stream epoch, and keeps the acknowledged unsynced interval visible as a recovery gap until authenticated account deletion.

Codex activity remains subject to OpenAI's service and privacy terms. Claude Code activity remains subject to Anthropic's service and privacy terms.

> **Hosted sync status.** The hosted sync endpoint is live as an open beta. Authenticated account deletion and capability-only progress recovery are implemented and pass deterministic hostile tests. Anyone can create an identity with an email address and a one-time code; an invitation is optional.

Report a suspected boundary violation through [private vulnerability reporting](https://github.com/hraness/hra/security/advisories/new).
