# Contents

- `local-data-removal.ts` – exact-target planning, renderer-safe previews, Keychain deletion receipts, signed native-helper launch requests, and a deterministic staged-removal reference executor.
- `local-data-removal-inventory.ts` – exact fixed-path and database-row inventory discovery, bundled-Git repository/worktree proof, and packaged-helper verification.
- `local-data-removal-recovery.ts` – startup-only helper recovery that runs before normal gateway state and returns a pathless private result or native launch.

# Guidelines

- Keep every renderer value path-free. Filesystem targets, Keychain descriptors, signing material, helper locations, and receipts remain private to the gateway/native boundary.
- Treat HRA-owned Codex profiles and managed worktrees as app-owned removal targets; require an explicit additional acknowledgement whenever any managed worktree is dirty.
- Preserve user repositories, external Codex data, taskctl credentials, and unrelated Keychain/filesystem data by validating exact category allowlists before any side effect.
- Bind confirmation to a short-lived preview and persist idempotent progress before crossing Keychain, native-helper launch, or application-quit boundaries. The helper is spawned first and must wait for the signed parent process to exit before deletion.
- Inventory every HRA human and runner Keychain generation plus committed, pending, deleting, and journal pointer entry under the exact HRA services; never enumerate or delete by broad service prefix.
- Derive destructive paths from the effective passwd home, never inherited `HOME`. Revalidate the complete inventory under the process-wide maintenance fence before the first Keychain side effect, and byte-check the signed helper request against the native limit at that same boundary.
- Reject symlinks, non-canonical paths, broad roots, escapes, overlaps with preserved repositories, and operation-ID reuse with a different request.
- Prove each managed checkout and reciprocal admin record belong to the preserved repository's actual Git common directory. Retain missing-checkout registrations so exact stale admin records are removed; treat a checkout with a missing admin record as dirty.
- Prefer atomic rename into operation-specific target and Git-admin tombstones, fsync every receipt transition, make every transition retryable, and keep deterministic fault checkpoints covered by focused tests.
