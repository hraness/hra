# Contents

- `main.dev.tsx` – the Vite-serve-only renderer root that composes the product app with development status.
- `DevHud.tsx` and `dev.css` – the accessible malleable-development pill, explanation, and explicit apply control.
- `protocol.ts` – strict browser-side parsing for coordinator status and Native development-reload responses.
- `apply.ts` – authoritative idle checks and the reserved, generation-fenced gateway apply transaction.
- `*.test.ts` and `*.test.tsx` – protocol, activity, transaction-order, presentation, and production-entry boundary examples.

# Guidelines

- Keep this entire directory reachable only from Vite's `serve` entry. Production `src/main.tsx` and emitted assets must contain no development status, endpoint, or reload marker.
- Treat Vite status as an untrusted, path-free file-change plane. Parse exact bounded envelopes and never render paths, compiler output, account identity, provider identity, or candidate hashes.
- Take a fresh parsed Native runtime snapshot before applying a staged gateway. Refuse while any pane, workspace preparation, or harness child is active.
- Reserve the exact staged candidate before asking Native to reload. Acknowledge only after the exact accepted transport generation is ready and a fresh authoritative snapshot succeeds.
- Never reload automatically. Busy, unavailable, malformed, or failed apply attempts preserve the current runtime and require a later explicit user action.
