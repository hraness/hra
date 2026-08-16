# Contents

- `local-convex.ts` – serial black-box acceptance against the anonymous local Convex HTTP boundary and real scheduler, including tenant-isolated task CRUD, graph laws, projection repair, idempotency, submissions/review, a 100-attempt claim race, exact 500-dependent propagation, pagination, claims, and events; an opt-in path measures 10,000 ready tasks.
- `run-local-convex.ts` – fail-closed local Convex supervisor that requires the child black-box gate's exact success marker.
- `fake-workos.ts` – loopback-only signed WorkOS, JWKS, membership, refresh, and webhook fixture without an authentication bypass.
- `human-local-runner.ts` – keeps Convex and the fake provider alive while running signed CLI auth, provisioning, two-session promotion manifest convergence, fixed-slot refresh limiting, webhook, reconciliation, authorization, repository, direct human-review limiting, human cancel/reopen, and in-review cancellation acceptance.
- `realtime-cli-proof.ts` – two-phase, signed-human Convex subscription proof that brackets a real `taskctl` claim subprocess and verifies its durable claim tuple and persisted agent event actor without a manual refresh.
- `realtime-cli-proof.test.ts` – deterministic marker and authoritative detail-observation regressions for the live subscription proof.

# Guidelines

- Run these tests only through a live anonymous local Convex deployment; do not substitute mocked database semantics.
- Seed unique two-tenant fixtures through identity-gated local fixture functions, never through a versioned HTTP bypass.
- Keep production lease and authorization behavior fixed; test-only helpers may shorten an already-created deadline behind the fixture gate.
- Assert public envelopes through `@hraness/agent-tasks-protocol` and inspect persistence only through the doubly gated fixture boundary.
- Use deterministic synthetic peppers and identities that cannot be confused with production credentials, and never print bearer tokens.
- Run serially and use bounded eventual assertions for real scheduler timing.
- Keep the 10,000-ready-task measurement opt-in; the default gate must still exercise the exact 500-dependent write boundary and 100 concurrent claim attempts.
- Keep the concurrent create batch as an optimistic-concurrency regression while running the agent and signed-human suites themselves serially.
- Make human-auth fixtures issue real RS256 JWTs through a JWKS endpoint and exercise the production-shaped provider adapter; never mint an identity inside a versioned API route.
- Sign fake webhook bodies with the WorkOS HMAC format and cover duplicate, delayed-read, provisioning-window, downgrade, removal, discovery, and restoration behavior through final HTTP authorization.
- Inspect persistence across provider removal/restoration and prove Convex-owned planner/viewer workspace assignments remain unchanged while live authorization is denied.
- Prove authenticated limit subjects are live Convex IDs, opaque pre-authentication subjects are fixed slot keys, independent refresh credentials can occupy independent slots, and refresh persistence stays within the fixed two-window row ceiling.
- Make membership-create ambiguity commit provider state before failing, hide that state from a later read, and assert recovery remains poll-only with exactly one provider POST.
