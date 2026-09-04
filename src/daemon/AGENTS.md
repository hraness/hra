# Contents

- The daemon hosts the local command authority, long-running Codex processes, and opaque session-memory lifecycle coordination.
- The Unix socket transports one bounded authenticated request at a time.
- Autorespond decides who answers an approval: the protocol path answers provider requests, the prose path answers an assistant turn that asks only for consent through the responder port.

# Guidelines

- Authenticate with an ephemeral capability stored in a user-only file. Never accept a socket, capability, or state root through argv or environment overrides in production.
- Validate owner, mode, type, link count, containment, and canonical path before using an endpoint.
- Use absolute wall-clock deadlines, close admission before shutdown, abort in-flight reads, and join every owned task before storage closes.
- Serialize mutations by their authority key. Allow bounded independent reads that cannot observe torn state.
- Never trust a responder's text. Autorespond sends one fixed approval sentence, or a literal proven byte-exact inside the assistant's own message, and every attempt leaves an evidence row with no message text, literal, or credential in it.
- Reconcile facts-memory creation, accepted-head ancestry, historical exact-head fork, and whole-directory cleanup by immutable owner/session/epoch binding. Fence parent cleanup behind unresolved child forks, admit live TTL from current host time, and clean every terminal commit immediately plus restart-safe isolated scans. Do not expose semantic-store selection or purge through commands or tools.
