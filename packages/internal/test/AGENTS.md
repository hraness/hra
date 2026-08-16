# Contents

- `src/index.ts` – the shared fast-check surface and deterministic synchronous/asynchronous assertion defaults.
- `src/index.test.ts` – evidence that defaults and shrinking stay active.
- `package.json` – the single cataloged fast-check dependency.

# Guidelines

- Tests import `fc`, `assertProperty`, and `assertAsyncProperty` from `@hra-internal/test` so run counts, interruption behavior, and dependency versions stay consistent.
- Generated properties need an independent oracle or named law and must be deterministic under a replayed seed/path.
- Do not hide a shrunk counterexample by increasing timeouts or filtering incoherent generators; pin it as an example and improve the model.
