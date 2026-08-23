# Contents

- `schema.ts` defines HRA cloud identity, device, envelope, projection, lease, command, and retention state.
- Auth modules implement verified-email login and device enrollment.
- Sync and command modules authorize exact device and lease generations.
- Tests prove rate limits, transactions, encryption boundaries, recovery, and retention.

# Guidelines

- Use one Convex Auth credentials provider. Do not add a second identity provider or accept email as authority after login.
- Store only purpose-separated challenge digests. Codes are one-time, rate-limited, and expire.
- Treat the authenticated user plus active device plus current auth epoch as the minimum write authority.
- Never accept plaintext session content, provider credentials, raw protocol data, raw reasoning, approval secrets, arbitrary tool output, or environment values.
- Keep functions strict and bounded. Reject unknown fields, stale revisions, stale leases, and replayed idempotency keys.
