# Contents

- `index.ts` – executable command dispatch and exit-code boundary.
- `args.ts` – strict command-line parsing from untrusted argv.
- `client.ts` – versioned task HTTP requests over the shared bounded parser.
- `claim-preflight.ts` – authoritative ownership checks and bounded automatic claim renewal for claim-bound mutations.
- `config.ts` – non-secret profiles and secret-store selection.
- `human-config.ts` – CLI filesystem/keychain adapters over portable human-authentication schemas.
- `human-custody-process-worker.ts` – stdin-only subprocess fixture for durable cross-process custody races.
- `secret-store.ts` – the Bun-backed implementation of the shared secret-store contract.
- `output.ts` – JSON, human-readable, stdout, and stderr rendering.
- `desktop-pairing.ts` – CLI error/browser adapters over the shared one-time pairing flow.

# Guidelines

- Parse argv and HTTP responses from `unknown`; use discriminated command and result unions internally.
- Generate an idempotency key for every domain mutation and return it in JSON output.
- Send the selected workspace on every human agent-lifecycle request; never source it from argv.
- Keep transport retries limited to operations whose protocol explicitly permits replay.
- Treat organization and workspace selection as whole-credential rotation. Commit the exact response through the immutable cross-process revision CAS, and preserve the exact involved slots in recovery quarantine when the response or custody commit is indeterminate.
- When a rotation throws after publishing its successor, resolve only the exact next generation with a full credential match; never quarantine an unrelated newer winner.
- Fail closed before a claim-bound mutation when ownership or a renewal response is inconsistent; keep renewal and target-mutation idempotency keys distinct.
- Redact authorization, refresh, enrollment, device, and agent-token values before formatting any diagnostic.
- Cover parser, output, redaction, and profile behavior with deterministic examples and appropriate property laws.
