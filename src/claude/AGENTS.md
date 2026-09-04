# Contents

- Pin holds the one exact Claude Code version, Fable model id, reasoning effort, and reviewed stream-json matrix digests.
- Runtime discovery locates and version-admits the pinned `claude` executable and builds its exact argv.
- Process spawns that executable under an isolated absolute `CLAUDE_CONFIG_DIR` with the same environment allowlist Codex uses.
- Protocol parses every stream-json line from `unknown` into a closed union and maps `can_use_tool` onto HRA interaction kinds.
- Assembler is the delta assembler: it owns turn, item, and subagent identity and emits the closed fact vocabulary the runtime consumes.
- Client owns one process, is the only writer of its stdin, and brokers control responses, steering, and interrupts.

# Guidelines

- Pin one exact Claude Code version. The stream-json surface is not a published contract, so refuse any other build and re-capture `docs/providers/claude-fixtures/` before changing the pin.
- Keep the split the bridge captures: this layer knows Claude's dialect, the daemon knows the timeline. Never leak a Claude wire shape past the fact vocabulary.
- Parse every foreign value from `unknown` with explicit bounds. An unrecognised event becomes a bounded protocol notice, never a silent accept and never a thrown fault on a live session.
- Answer a `can_use_tool` request only by echoing its own `input`. Never send `permission_suggestions`, so HRA can grant nothing beyond `once`.
- Never read, copy, or forward a Claude credential. The isolated `CLAUDE_CONFIG_DIR` is the whole authentication boundary.
- Sanitize every provider string that can reach a display, projection, or log: absolute paths reduced, credential-shaped runs replaced, unsafe terminal scalars folded.
