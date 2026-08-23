# Contents

- Auth implements verified-email HRA identity and device credentials.
- Sync encrypts and uploads bounded local projections.
- Remote control claims commands under one execution lease.

# Guidelines

- Cloud absence cannot block local login, execution, recovery, or transcript reads.
- Encrypt content before transport. Server-visible fields remain opaque identifiers, revisions, states, and bounded timestamps.
- Revalidate current user, device, key version, and lease generation on every protected mutation.
- Treat dispatched-but-unconfirmed writes as indeterminate. Reconcile by idempotency key before retry.
