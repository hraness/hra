# Contents

- `config.ts` – optional cloud API and WorkOS public-client environment parsing with fail-closed disabled states.
- `keychain-custody.ts` – Bun Keychain adaptation, generation-preserving human credential custody, and token-free metadata ports.
- `http-client.ts` – strict typed human-account and HRA workspace HTTP transports.
- `human-account-service.ts` – optional device sign-in, safe renderer snapshots, organization/workspace selection, refresh, cancellation, and sign-out.
- `workspace-summary-cache.ts` – user, organization, and credential-generation-fenced nonblocking cloud workspace summary refresh.
- `invalidation-coordinator.ts` – cancellation-aware, generation-fenced cloud invalidation polling.
- `authority-router.ts` – provider-neutral local/cloud selection with promotion and recovery fail-closed states.
- `interaction-sealer.ts` – gateway-boundary HITL sealing that returns only the ciphertext envelope.
- `session-sync-http-client.ts` – strict token-stateless encrypted-session relay transport, device-proof signing, and negotiated clock calibration.
- `session-sync-key-custody.ts` – fixed-installation Keychain custody for device private keys and the bounded vault-root keyring.
- `session-sync-local-crypto.ts` – separate-domain encryption for sequence-free local summary intents before SQLite persistence.
- `session-sync-coordinator.ts` – explicit-consent enrollment, publication, observation, presence, projection, and bounded shutdown orchestration.
- `index.ts` – gateway integration exports for the cloud boundary.

# Guidelines

- Never persist, log, throw, emit, or project access tokens, refresh tokens, device codes, authorization headers, plaintext interaction answers, or raw upstream bodies.
- Keep optional cloud configuration fail-closed. Missing or invalid configuration performs no network access and must not affect account-free local workspaces.
- Store human credentials only through the `kitchen.hraness.cloud-human.v1` Keychain service. SQLite implementations may persist only the exported custody journal and token-free account metadata.
- Fence asynchronous sign-in, refresh, workspace selection, and invalidation work by credential and loop generation. A stale completion cannot update state or emit an invalidation.
- Parse every HTTP request and response through the shared protocol schemas, then re-check route workspace, projection-head, and immutable cursor bindings before returning data.
- Route exactly one adapter from durable workspace authority. Promotion, activation ambiguity, and explicit recovery states have no writable adapter.
- Seal HITL plaintext at this gateway boundary and pass only the protocol ciphertext envelope to cloud transport.
- Keep session-summary plaintext and vault-root bytes inside the gateway process. Persist only ciphertext, authenticated outer coordinates, bounded cursors, and product-safe retry metadata; keep device PKCS8 and vault-root keyrings only in the fixed Keychain record.
- Session sync is an optional observer. Missing configuration, sign-out, relay failure, malformed remote ciphertext, and shutdown must never block, roll back, or rewrite a local pane, Codex process, or worktree.
- Mint each device proof inside the human-session callback, bind it to the exact route and canonical body digest, calibrate only from negotiated server time with bounded midpoint uncertainty, and replay a mutation only after an explicit pre-effect rejection.
