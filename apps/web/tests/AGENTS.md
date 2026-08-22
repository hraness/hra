# Contents

- `local-convex.ts` – serial black-box acceptance against the anonymous local Convex HTTP boundary and real scheduler, including tenant-isolated task CRUD, graph laws, projection repair, idempotency, submissions/review, a 100-attempt claim race, exact 500-dependent propagation, pagination, claims, and events; an opt-in path measures 10,000 ready tasks.
- `run-local-convex.ts` – fail-closed local Convex supervisor that requires the child black-box gate's exact success marker.
- `fake-desktop-pairing.ts` – loopback-only one-time pairing fixture for CLI protocol acceptance without an authentication bypass.
- `human-local-runner.ts` – keeps Convex alive while proving password sign-up/sign-in, browser-approved desktop pairing, refresh rotation, scope rotation, revocation, and authenticated human task authority.
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
- Exercise real Convex Auth password sessions through public auth routes; never mint a human identity inside a versioned API route.
- Keep the pairing verifier on the native side, compare the browser code, approve an exact organization/workspace, and prove one-time redeem plus consumed replay.
- Recheck current Convex-owned membership on refresh and every protected request, and prove removal immediately denies authority without erasing workspace assignments.
- Prove authenticated limit subjects are live Convex IDs, opaque pre-authentication subjects are fixed slot keys, independent refresh credentials can occupy independent slots, and refresh persistence stays within the fixed two-window row ceiling.
- Make lost pairing and scope-rotation responses fail closed, and prove retries never revive the invalidated prior credential.
