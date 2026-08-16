# Contents

- `environment.ts` – complete allowlisted child-process environment construction.
- `renamed-environment.ts` – conflict-checked HRA environment reads with exact pre-rename aliases.
- `redaction.ts` – bounded, renderer-safe compatibility and error diagnostics.

# Guidelines

- Construct child environments from an allowlist; never clone the gateway or app environment.
- Keep tokens, prompts, answers, command bodies, raw protocol payloads, account emails, and local paths out of diagnostics.
- Redaction is a final safety net, not permission to log arbitrary foreign values.
- Keep secret interaction values out of persistence and operation receipts as well as logs.
