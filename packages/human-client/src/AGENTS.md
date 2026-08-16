# Contents

- `human-auth.ts` – safe account metadata and secret-bearing authentication schemas.
- `strict-http.ts` – origin-confined, redirect-free, bounded typed JSON requests.
- `secret-custody.ts` – secret-store ports and crash-recoverable generation/slot journals.
- `session.ts` – signed-out-safe access calls and serialized refresh-token rotation.
- `workos-device.ts` – bounded WorkOS public-client device authorization.
- `redaction.ts` – static secret-safe diagnostic helpers.
- `index.ts` – the production package surface.
- `*.test.ts` and `*.property.test.ts` – deterministic behavior, concurrency, and parser laws.

# Guidelines

- Accept foreign data as `unknown` and validate it before use.
- Never include bearer values, response bodies, URLs with sensitive query fields, or provider messages in errors.
- Keep route handling generic so versioned HRA human HTTP descriptors can use the same transport.
- Do not invoke an operation or refresh driver when custody reports no account.
- Coalesce concurrent refreshes and compare generations before every credential replacement or clear.
- Keep keychain values opaque to metadata adapters; journal records may contain only service, name, slot, and generation facts.
