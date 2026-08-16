# Contents

- `contracts.ts` – renderer-safe promotion progress, recovery, authority-overlay, stable-fault, lifecycle, and cloud-transport ports.
- `source-snapshot.ts` – strict portable SQLite snapshot extraction and preflight validation used inside the store's immediate transaction.
- `coordinator.ts` – serialized start, resume, receipt reconciliation, activation, abort, cleanup, retry, and wake lifecycle.
- `http-transport.ts` – credential-aware strict HTTP adapter for the fixed HRA promotion route surface with durable UUIDv7 idempotency keys.
- `runner-pairing.ts` – post-activation imported-runner enrollment, redemption, generational Keychain custody, replay, and gateway-only dispatch authorization recovery.
- `index.ts` – public runtime composition exports for main-process wiring.

# Guidelines

- Keep every source read, manifest calculation, entity insert, and local authority freeze inside one immediate SQLite transaction before the first cloud call.
- Persist only portable promotion entities, compact checkpoints, exact receipts, safe faults, and token-free account metadata; never persist paths, credentials, commands, interactions, transcripts, or raw provider output.
- Treat batch and activation ambiguity as durable protocol state. Reconcile server receipts before replay and never restore local writes without a bound server abort proof.
- Preserve the source workspace and all of its local rows after activation. Normal navigation follows cloud authority while the source is exposed only as an explicit read-only recovery copy.
- Keep runner pairing separate from activation: an accepted activation creates a pending pairing record but cannot make pairing success part of the promotion decision.
- Treat credential and session minting as `pairing`; only an accepted dispatch-runner heartbeat may advance the durable status to `paired`.
