# Security architecture

HRA separates durable task coordination from local Codex execution. The web
control plane can describe and supervise work, while a paired Mac retains the
credentials and capabilities needed to run it.

## Security goals

HRA is designed to:

- isolate organizations, workspaces, humans, agents, and local installations;
- prevent stale claims or replaced runners from continuing to mutate work;
- keep Codex credentials, provider sessions, raw transcripts, tool payloads,
  commands, output, and canonical paths off the web control plane;
- bind each local effect to a current account, process generation, task claim,
  repository, and managed worktree;
- preserve enough durable state to recover without repeating an ambiguous
  provider or repository mutation;
- keep optional cross-device session data encrypted end to end and limited to
  a summary projection.

## Trust boundaries

### Web control plane

The web application owns organizations, workspaces, tasks, dependencies,
claims, submissions, reviews, bounded display events, and human decisions.
Convex Auth authenticates humans with password-first accounts. Convex owns the
user, organization, and workspace membership records alongside the authorized
task graph, and reloads tenant and role authority at each external boundary.
Desktop and CLI clients receive an ordinary Convex Auth session only after a
short-lived, verifier-bound browser pairing is approved by the signed-in human;
the resulting rotating credentials remain in the existing Keychain custody.

The browser is a supervision client. It cannot hold Codex credentials, select
canonical local paths, start an arbitrary provider operation, or become the
authority for a desktop session.

### Desktop application

The desktop gateway owns Codex account connections, provider sessions, local
SQLite state, managed Git worktrees, and execution recovery. Credential and key
material is held through macOS Keychain-backed custody where the corresponding
feature requires it.

The React renderer receives bounded projections through a narrow native
bridge. It does not receive provider credentials, raw cloud diagnostics,
canonical paths, or unrestricted process and filesystem capabilities.

### Command-line client

`taskctl` consumes the versioned HTTP task API. Human sessions and agent
credentials are independently scoped and revocable. The CLI does not import
the Convex server implementation or generated data-model types.

## Runner authority and recovery

A workspace grants runner authority to one paired installation at a time. The
installation advertises aggregate capacity and an explicit repository mapping,
then claims eligible work over outbound HTTPS. Each accepted run is fenced by
the installation, runner boot, task claim, dispatch attempt, repository, and
managed worktree.

Renewable leases bound how long a disconnected runner can retain authority.
Every task mutation revalidates the active tenant, role, claim, and fence. A
new installation or claim supersedes the old one before the replacement can
write.

Local effects use staged receipts so restart recovery can distinguish a
prepared operation, a proven result, and an ambiguous operation. An ambiguous
non-idempotent effect is not repeated automatically.

## Data sent to the web control plane

The task service accepts bounded task content and a strict display-event union:
lifecycle state, reasoning-summary text, assistant-message text, and
content-free tool activity. Unknown fields and unsupported event variants fail
closed. Raw reasoning, tool names and arguments, environment values, commands,
diffs, command output, provider identifiers, and local filesystem paths are
outside that contract.

Accepted summary and assistant text is readable by the service and receives no
semantic secret-detection guarantee. Do not put credentials or sensitive local
data in task descriptions, comments, summaries, assistant messages, or remote
questions.

## Human decisions during a run

Remote human interaction supports only bounded question choices and opaque
managed-worktree file decisions. Secret requests, command and permission
payloads, unsupported callback types, file contents, diffs, and output are
rejected before synchronization.

The browser encrypts an accepted answer to a boot-scoped desktop key. The
envelope is bound to the workspace, run, interaction, runner, boot, claim,
fence, request digest, expiry, and key identifier. The service relays the
envelope and deletes it after acknowledgement or expiry. The desktop accepts
it only while the exact request and boot remain live.

Question text and options are visible to the service so a human can answer
them. Structural validation cannot detect every secret embedded in ordinary
prose, so users must not request or paste sensitive data there.

## Cross-device session summaries

Cross-device synchronization is optional and local-first. It sends only an
encrypted `session_summary` projection with bounded fields such as title,
repository display name, model effort, coarse state, source revision, origin
device, and deletion state. Prompts, responses, transcripts, raw reasoning,
tool details, account identity, provider identifiers, and filesystem paths are
excluded.

Remote summaries are view-only. Local session creation, sending, streaming,
rename, workspace selection, and recovery continue without the service. The
relay can observe traffic timing, bounded ciphertext sizes, opaque identifiers,
and membership churn. It can also delay or withhold data. Signed membership
chains and local pins turn a detected rollback into loss of availability rather
than accepted stale state.

## Repository and process isolation

Repository mappings must identify an explicit absolute repository root.
Relative paths, symlink escapes, duplicate roots, nested substitutions, and
unexpected Git common directories are rejected. Writing runs receive separate
managed worktrees and bounded leases.

Recursive agent programs reduce depth, descendants, tokens, deadlines, bytes,
and lane authority at each child. Admission binds operations to an exact live
Codex account, binary, process generation, root session, repository, and
request. Persisted files and SQLite rows cannot grant current provider
authority by themselves.

## Supply chain

The repository pins Bun and Node versions, resolves JavaScript dependencies in
`bun.lock`, pins native runtime metadata and generated Codex schemas, and
retains licenses and provenance for vendored fonts, artwork, interface code,
Codex, and Git. The default GitHub workflow has read-only permissions, persists
no checkout credential, consumes no repository secret, and builds no signed or
published artifact.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled component
licenses and provenance paths.

## Known limits

- Human-authentication revocation depends on provider webhook delivery or a
  later reconciliation pass, with short-lived tokens as an additional bound.
- Hosted availability, data residency, backup retention, DDoS protection, and
  incident alert delivery depend on the deployment chosen by an operator.
- Display text and remote question text are bounded structurally but are not
  guaranteed to be free of sensitive prose.
- End-to-end encryption does not hide traffic timing, ciphertext size within
  the documented bound, or membership activity.
- Revocation cannot erase data already decrypted, copied, captured, or backed
  up on another device.
- A crash around an ambiguous non-idempotent effect can leave work waiting for
  human inspection instead of retrying automatically.

Report a suspected design or implementation flaw through the process in
[SECURITY.md](SECURITY.md).
