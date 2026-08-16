# Contents

- `index.ts` – executable command dispatch and exit-code boundary.
- `args.ts` – strict command-line parsing from untrusted argv.
- `client.ts` – versioned task HTTP requests over the shared bounded parser.
- `claim-preflight.ts` – authoritative ownership checks and bounded automatic claim renewal for claim-bound mutations.
- `config.ts` – non-secret profiles and secret-store selection.
- `human-config.ts` – CLI filesystem/keychain adapters over portable human-authentication schemas.
- `secret-store.ts` – the Bun-backed implementation of the shared secret-store contract.
- `output.ts` – JSON, human-readable, stdout, and stderr rendering.
- `workos-device.ts` – CLI error/browser adapters over the shared WorkOS device flow.

# Guidelines

- Parse argv and HTTP responses from `unknown`; use discriminated command and result unions internally.
- Generate an idempotency key for every domain mutation and return it in JSON output.
- Send the selected workspace on every human agent-lifecycle request; never source it from argv.
- Keep transport retries limited to operations whose protocol explicitly permits replay.
- Fail closed before a claim-bound mutation when ownership or a renewal response is inconsistent; keep renewal and target-mutation idempotency keys distinct.
- Redact authorization, refresh, enrollment, device, and agent-token values before formatting any diagnostic.
- Cover parser, output, redaction, and profile behavior with deterministic examples and appropriate property laws.
