# Contents

- `protocol.ts` defines the closed OOC1 wire codec and the pure host observation reducer.
- `protocol.test.ts` tests framing, binding, ordering, deadlines, and terminal admission without starting a process.
- `protocol.md` freezes the native helper contract and the limits of its direct-child evidence.
- Native helper and fixture files exercise the same contract under an explicitly owned test process.

# Guidelines

- Keep this boundary source-only until the platform implementation and its real process tests are independently admitted. Windows remains unqualified.
- The helper owns one direct child. Report terminal evidence only after reaping that exact child; never infer descendant containment, provider-effect rollback, or permission for a replacement writer.
- Bind every frame to one unpredictable nonce and authority generation. Keep the child behind a pre-exec gate until the exact single GO command.
- Refuse malformed, duplicate, out-of-order, oversized, unknown-version, and mismatched frames. Failure is sticky; no new handshake may reuse the helper.
- Bound startup, run, shutdown, frames, retained bytes, and frame counts. Native monotonic deadlines remain independent of a responsive host.
- A host admits direct-child proof only after the exact terminal frame, successful helper exit, and clean control EOF. Missing or contradictory observations and owner loss remain uncertain.
- Use credential-free fixtures and owned disposable files. Preserve all existing production platform guards, authority rules, and recovery contracts.
