# Contributing

HRA is in public beta development. Open an issue before a large change so the authority and compatibility boundary can be agreed first.

## Local setup

1. Install Bun 1.3.14.
2. Run `bun install --frozen-lockfile --ignore-scripts`.
3. Run the focused test beside the code you change.
4. Run `bun run check` before submitting a change.

## Change requirements

- Add a deterministic regression for each corrected failure.
- Add property tests for new parsers, reducers, state transitions, ordering rules, and serialization laws.
- Update `kb/plans/` when a change alters a recorded product decision or acceptance gate.
- Keep generated files reproducible and include the generator input.
- Do not commit credentials, account identifiers, local paths, transcripts, or provider payloads.

By contributing, you agree that your contribution is licensed under the MIT License.
