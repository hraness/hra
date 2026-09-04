# Contents

- Migrations create the local SQLite authority.
- Repositories implement narrow semantic reads and CAS transitions.
- Secret custody stores HRA device credentials, encryption keys, and the autorespond gateway key.
- State paths select platform roots, profile directories, and isolated facts-memory session roots.
- The attachment blob store keeps message attachment bytes as user-only, digest-named files outside SQLite; `attachments` and `message_attachments` hold only their accounting and manifest.

# Guidelines

- Use `STRICT` tables, foreign keys, checks, and transition triggers for durable state machines.
- Migrations are append-only, transactional, idempotent under restart, and downgrade-tested when a release can encounter an older binary.
- Never persist provider tokens, raw protocol payloads, arbitrary tool output, approval secrets, or environment values.
- Never put attachment bytes in a table. A row may carry a digest, a declared name, a media type, and a length; the bytes stay in the content-addressed store and are re-proved against their digest on every read.
- Use immutable secret generations. Quarantine uncertain values without deleting recovery evidence.
- Keep each semantic memory store epoch in one validated session directory outside control-plane SQLite. Purge the exact epoch directory as a unit, including SQLite sidecars and caches; never put semantic payloads in HRA lifecycle tables. Validate legacy adapter and receipt digests against their exact historical preimages before atomically migrating only an empty create or an empty fork whose parent head is also empty; never bless normalized fields under an old digest. A cleanup-only legacy reader may return only exact binding, opaque handle, and Oh-binding authority after bounded no-follow descriptor validation and handle recomputation; it must never normalize, migrate, or return a head. Bound local database plus WAL bytes before open/verify and bound the exact fork serialization before creating the child.
