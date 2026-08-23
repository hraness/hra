# Contents

- Identifiers and schemas define bounded product values.
- Reducers model profile, process, session, turn, queue, switch, sync, and recovery states.
- Presets compile user aliases against observed provider capabilities.
- Encryption models account-data keys, device envelopes, and encrypted projections.

# Guidelines

- Make invalid states unrepresentable where possible and reject incoherent persisted rows otherwise.
- Keep transitions pure and exhaustive. Attach effect execution through ports outside this directory.
- Property-test parser totality, canonical ordering, revision monotonicity, transition legality, encryption round trips, tamper rejection, and idempotency.
- Keep account labels, provider identity, paths, and text out of content-free authority records.
