# Contents

- `attention.ts` – canonical pathless attention items, precedence, grouping, ordering, and strict projection schema.
- `panes.ts` – minimized pathless pane-list projection for local users and agents.
- `wire.ts` – one-request local observation channel with a read-only generation capability.
- `index.ts` – package root exports.
- `*.test.ts` and `*.property.test.ts` – parser, privacy, bounds, canonical-order, and round-trip laws.

# Guidelines

- Derive presentation groups and item keys from immutable reasons instead of serializing redundant mutable labels.
- Emit at most one attention item per pane and account, and at most one row per workspace/reason pair.
- Preserve pane grid order in the pane-list projection; attention uses its own canonical severity and display ordering.
- Keep setup authority opaque. Only the request ID, recipe digest, setup revision, and closed result code may cross this boundary.
- Keep the wire request single-use per connection and free of endpoint overrides. Never render or log its capability.
