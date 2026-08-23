# Cloud retention

The hosted sync endpoint remains unavailable until the implemented account-deletion workflow passes fresh-deployment and live completion acceptance. These periods are cleanup targets for records that can expire without a user request. They are not hard deletion deadlines: bounded maintenance can take longer while it drains a backlog.

| Record | Cleanup target | Cleanup rule |
| --- | ---: | --- |
| Email send attempts | 24 hours | Delete after `expiresAt`. |
| Email verification attempts | 1 hour | Delete after `expiresAt`. |
| Email-code challenges | 10 minutes | Delete after `expiresAt`; successful verification consumes all live challenges for the address. |
| Device-bind challenges | 5 minutes | Delete after `expiresAt`; a completed challenge cannot be reused. |
| Idempotency receipts | 7 days | Delete after `expiresAt`, after the lost-response recovery window. |
| Pending remote commands | Through their deadline | Mark `expired` after the deadline when no provider effect was prepared. |
| Applied, failed, ambiguous, cancelled, or expired remote commands | Until the exact requesting device acknowledges its durable receipt, then at least 30 more days | Unacknowledged terminal evidence is not cleanup-eligible. Acknowledgement is bound to the command ID, idempotency key, and request digest so a lost enqueue response remains recoverable without replaying the provider effect. |
| Security events | 90 days | Delete by creation time. |
| Encrypted devices, account projections, usage projections, sessions, chunks, metadata, and key envelopes | Until authenticated account deletion | Retain to provide multi-device sync. Append-only compact-projection recovery preserves every older encrypted chunk, records the new epoch at the global head plus one, and leaves the acknowledged recovery gap visible. |
| Authentication user, subject, account, session, and refresh-token records | Through the configured session lifetime, then until authenticated account deletion where applicable | Convex Auth expires sessions; account deletion must remove remaining owned records. |

Scheduled maintenance rotates its starting category and gives each eligible category up to 20 records within one hard 200-record transaction ceiling. Deletion and revocation also receive a reserved one-minute worker quantum. These bounds prevent starvation without promising a maximum wall-clock deletion time under sustained backlog.

`hra auth delete --acknowledge-erasure` durably prepares an identity-scoped job and secret status capability before requesting deletion. The first hosted transaction disables the authentication subject and advances its epoch before scheduling bounded removal of every user-owned category. Exact retry after response loss reuses the same job; `hra auth status` reports capability-only progress after authentication records are gone. Deterministic tests prove immediate authority revocation and incremental removal. Fresh-deployment and live completion acceptance remain launch gates.
