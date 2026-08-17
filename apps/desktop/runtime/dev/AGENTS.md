# Contents

- `change-classifier.ts` and `classify.ts` – strict repository-relative live, staged gateway, restart, and ignored development lanes.
- `status-protocol.ts` and `vite-plugin.ts` – browser-safe bounded status envelopes, same-origin mutation admission, HMR status delivery, and cold-update suppression.
- `gateway-builder.ts` and `gateway-coordinator.ts` – serialized candidate compilation, content-addressed staging, explicit reservation, and atomic adoption after generation readiness.

# Guidelines

- Keep this graph serve-only. Production frontend and gateway builds must not import it.
- Keep plain `dev:frontend` UI-only. Only the launcher-supplied canonical session may watch, compile, reserve, acknowledge, or cancel gateway candidates.
- Parse strict repository-relative POSIX paths. Reject traversal and absolute paths, and never send paths, logs, account data, prompts, or compiler output to the renderer.
- Leave the stable gateway unchanged while a candidate is building, staged, or applying. Stage by SHA-256 beside the stable executable, reserve one immutable candidate, and atomically adopt it only after Native proves the exact generation ready and the renderer reads a fresh authoritative snapshot.
- Never automatically interrupt active work. Coalesce gateway edits while one candidate is applying, and make any Native, launcher, contract, migration, maintenance, security, key-custody, or release change a terminal restart fence for that development session.
- Keep status revisions monotonic, envelopes exact and bounded, and mutation endpoints no-store, same-origin, session-bound, candidate-bound, and without CORS authority.
