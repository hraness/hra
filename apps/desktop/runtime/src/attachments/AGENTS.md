# Contents

- `contracts.ts` – gateway-private attachment-vault command, metadata, preview, provider-lease, and provider-delivery boundaries.
- `validation.ts` – opaque identity, display-basename, media-type, digest, revision, and bounded base64 validation.
- `normalizer.ts` – exact native image-normalizer process protocol and path-free receipt parsing.
- `vault-filesystem.ts` – canonical private-root, no-follow regular-file, atomic publication, inventory, digest-read, fsync, and exact deletion authority.
- `vault.ts` – SQLite and private-filesystem attachment lifecycle, reconciliation, leases, digest-verified reads, and garbage collection.

# Guidelines

- Keep attachment paths and bytes behind the gateway. Renderer projections may contain only opaque IDs, bounded sanitized display basenames, media metadata, byte counts, kind, revision, and lifecycle state. Preview bytes may cross only through an explicit same-pane relationship-checked read.
- Accept upload bytes only as strict canonical base64 chunks of at most 512 KiB decoded, in exact ordinal order under an exact attachment revision. Persist the prepared chunk cut before writing, fsync the file, and settle the committed chunk receipt after the write. Never replay changed bytes under an old ordinal.
- Keep vault directories at mode 0700 and files at mode 0600. Reject links, special files, unexpected hard links, changed identities, unexpected directory entries, and paths outside the canonical vault root. Fsync files and their owning directories at publication cuts.
- Normalize PNG, JPEG, HEIC, and WebP only through the signed native helper. Treat its exact two-file generation and path-free digest receipt as the image publication boundary. Generic files remain immutable byte-exact blobs and are never rendered or executed by HRA.
- Hash every preview, provider, backup, and reconciliation read. A mismatch atomically contains the attachment as corrupt before returning failure. Never expose an unverified path to a provider effect.
- Charge every durable physical artifact: the source reservation before publication, canonical plus preview plus retained source during image publication, and exact provider bytes afterward. Persist a verified image receipt before final quota admission so a rejection or crash cannot strand unaccounted output. Remove helper-owned temporary generations synchronously on helper failure and again during startup reconciliation.
- Acquire provider-thread leases durably before an attachment can enter a provider effect. Retain them across message settlement and history pruning. Release only after an explicit gateway proof that the old binding cannot resume, or as part of the authorized privacy-deletion containment cut.
- Garbage-collect expired incomplete drafts and terminal unreferenced objects only after the grace window and only when one transaction proves that no live draft, message, turn, or provider-thread lease retains the attachment. Revoke terminal message references without deleting immutable delivery evidence.
- Pane archive uses a prepared/pane-archived/completed SQLite journal joined atomically to the pane archive transaction; never delete bytes from a merely prepared live-pane intent. Privacy deletion must carry distinct authorization and provider-containment receipts, then retain its journal until bytes, bindings, and tombstones are purged.
