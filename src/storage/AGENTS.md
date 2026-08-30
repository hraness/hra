# Contents

- Migrations create the local SQLite authority.
- Repositories implement narrow semantic reads and CAS transitions.
- Secret custody stores HRA device credentials and encryption keys.
- State paths select platform roots, profile directories, and isolated facts-memory session roots.

# Guidelines

- Use `STRICT` tables, foreign keys, checks, and transition triggers for durable state machines.
- Migrations are append-only, transactional, idempotent under restart, and downgrade-tested when a release can encounter an older binary.
- Never persist provider tokens, raw protocol payloads, arbitrary tool output, approval secrets, or environment values.
- Use immutable secret generations. Quarantine uncertain values without deleting recovery evidence.
- Keep each semantic memory store epoch in one validated session directory outside control-plane SQLite. Purge the exact epoch directory as a unit, including SQLite sidecars and caches; never put semantic payloads in HRA lifecycle tables.
