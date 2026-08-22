# Contents

- `projection.ts` – fresh allowlisted pane minimization from live gateway pane state.
- `endpoint.ts` – owner-private fixed endpoint material and generation capability custody.
- `server.ts` – bounded one-request AF_UNIX read server with injected attention and pane captures.
- `*.test.ts` – privacy, capability, framing, timeout, concurrency, profile, and cleanup regressions.

# Guidelines

- Start this server only for normal production or source-development gateway profiles. Automation and recovery-only startup must create no endpoint material.
- Bind beneath the activated explicit application-support root. Keep the directory mode `0700`, socket and capability mode `0600`, and reject symlinks, hard links, foreign owners, and unexpected file types.
- Generate a fresh 256-bit capability for every server generation and compare decoded bytes in constant time. Never return or log the capability.
- Read one EOF-framed request per connection within the shared request, response, and timeout ceilings. Bound concurrent connections and close every accepted socket during shutdown.
- Capture live state only after authorization. Construct pane output field by field; never accept, clone, stringify, or return a `RuntimeSnapshot`.
