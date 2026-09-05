# Contents

- Pin owns the exact externally installed Devin CLI version and Astra model family.
- Runtime locates and version-admits that executable and constructs the exact ACP argv.
- Process owns the isolated HOME/XDG environment and direct Bun child-process bridge.
- Auth projects status to a boolean and runs interactive login with terminal-signal custody.
- Protocol validates ACP v1 values from `unknown` and projects a small bounded fact vocabulary.
- Client owns one ACP process, serializes writes, correlates requests, and refuses concurrent prompts.

# Guidelines

- Keep this provider boundary self-contained. Wire values never cross it; only projected Devin facts do.
- Require Devin CLI `3000.6.14`, ACP v1, and model `gpt-6-astra`; fail closed on drift.
- Override HOME and every XDG directory. Never read, copy, return, or log credentials or account identity.
- Bound each inbound line and every projected string, array, identifier, and number.
- Ignore unknown vendor notifications only after validating and bounding the JSON-RPC envelope.
- Reject malformed recognized ACP frames and close the client rather than parsing them hopefully.
- Keep queueing and steering policy outside this directory. One prompt per session may be active.
- Tests use fake processes and protocol peers. Never issue a paid prompt from the test suite.
