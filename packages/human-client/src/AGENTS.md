# Contents

- `human-auth.ts` – safe account metadata and secret-bearing authentication schemas.
- `strict-http.ts` – origin-confined, redirect-free, bounded typed JSON requests.
- `secret-custody.ts` – secret-store ports and crash-recoverable generation/slot journals.
- `session.ts` – signed-out-safe access calls and serialized refresh-token rotation.
- `desktop-pairing.ts` – bounded one-time browser pairing with a locally held verifier.
- `redaction.ts` – static secret-safe diagnostic helpers.
- `index.ts` – the production package surface.
- `*.test.ts` and `*.property.test.ts` – deterministic behavior, concurrency, and parser laws.

# Guidelines

- Accept foreign data as `unknown` and validate it before use.
- Never include bearer values, response bodies, URLs with sensitive query fields, or provider messages in errors.
- Keep route handling generic so versioned HRA human HTTP descriptors can use the same transport.
- Do not invoke an operation or refresh driver when custody reports no account.
- Coalesce concurrent refreshes and compare generations before every credential replacement or clear.
- After an indeterminate product credential rotation, retire the exact inspected committed and pending pointers to durable quarantine without deleting their Keychain bytes or promoting pending state.
- Resolve a failed exact-generation containment against the current store before closing admission; a valid newer credential, including a newly selected scope, remains authoritative.
- Resolve a false or indeterminate definitive-authentication clear the same way: only a proven null store or valid newer generation may keep bearer admission open.
- Reopen recovery-contained admission only after active operations and refresh settlement finish and the product owner has committed a fresh credential; terminal signout remains closed at the product boundary.
- Keep keychain values opaque to metadata adapters; journal records may contain only service, name, slot, and generation facts.
- Treat version-one human custody as recovery-required input; never reinterpret or silently clear it as version two.
