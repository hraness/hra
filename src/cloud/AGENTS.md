# Contents

- Auth implements verified-email HRA identity and device credentials.
- Sync encrypts and uploads bounded local projections.
- Remote control claims commands under one execution lease.

# Guidelines

- Cloud absence cannot block local login, execution, recovery, or transcript reads.
- Encrypt content before transport. Server-visible fields remain opaque identifiers, revisions, states, and bounded timestamps.
- Revalidate current user, device, key version, and lease generation on every protected mutation.
- Treat dispatched-but-unconfirmed writes as indeterminate. Reconcile by idempotency key before retry.
- Keep `bun run test:simulation` as the bounded in-memory campaign for execution leases, command authority, and the command reducer. Reproduce one failure family with the exact command printed by the failure, using `HRA_SIMULATION_CAMPAIGN=<leases|authority|reducer>` and `HRA_SIMULATION_SEED=<seed>`, then retain its action trace as a named regression. The campaign checks only the transitions, rejection-inertness, fencing monotonicity, action-family coverage, and supplied healthy-path witness executed by those finite schedules. It does not prove every transition, scheduler fairness, eventual progress, or Convex, daemon, provider, process, and network behavior.
