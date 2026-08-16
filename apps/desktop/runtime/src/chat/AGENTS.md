# Contents

- `types.ts` defines the provider-neutral pane, account, repository, projection, and provider ports.
- `chat-service.ts` owns per-pane serialization, cross-pane concurrency, turn effects, proven quota failover, and fail-closed recovery.
- `codex-chat-provider.ts` adapts the pinned Codex protocol to fixed HRA chat configuration and text-only history handoff.
- `text-bounds.ts` maintains exact UTF-8 stream offsets and Unicode-safe bounded tails.
- `index.ts` is the gateway-owned chat API.

# Guidelines

- Send only renderer-safe pane projections and provider-neutral activity. Keep prompts, paths, usage, credentials, provider IDs, and retained history inside the gateway.
- Start, resume, and turn every Codex thread with `gpt-5.6-sol`, `on-request`, `auto_review`, and `workspace-write`; accept only `ultra` or `max` reasoning effort and owned `standard` or `fast` service tiers.
- Map Standard to the provider default, pass Fast at all three boundaries, and prove Fast is advertised by the exact account/model catalog before any provider mutation.
- Automatically continue on another account only after current-generation quota proof and a complete bounded text-only handoff. Never replay an ambiguous effect or incomplete history.
- Serialize effects independently per pane. Let different panes run concurrently, reject queueing and steering, and keep one logical turn active in each pane.
- Fail closed on unexpected interaction requests, interrupt or detach the provider turn, and leave the pane able to accept a later message.
- Run the focused chat store, service, adapter, transition, and property tests before the desktop affected gate.
