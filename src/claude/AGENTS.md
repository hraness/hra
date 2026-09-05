# Contents

- Pin holds the one exact Claude Code version, Fable model id, reasoning effort, and reviewed stream-json matrix digests.
- Runtime discovery locates and version-admits the pinned `claude` executable and builds its exact argv.
- Process spawns that executable with the same environment allowlist Codex uses. Managed profiles set a reviewed absolute `CLAUDE_CONFIG_DIR`; the explicitly bound personal profile omits that variable so Claude resolves its canonical default home itself. The runtime profile records which mode was used.
- Protocol parses every stream-json line from `unknown` into a closed union and maps `can_use_tool` onto HRA interaction kinds.
- Assembler is the delta assembler: it owns turn, item, and subagent identity and emits the closed fact vocabulary the runtime consumes.
- Client owns one process, is the only writer of its stdin, and brokers control responses, steering, and interrupts.

# Guidelines

- Pin one exact Claude Code version. The stream-json surface is not a published contract, so refuse any other build and re-capture `docs/providers/claude-fixtures/` before changing the pin.
- Keep the split the bridge captures: this layer knows Claude's dialect, the daemon knows the timeline. Never leak a Claude wire shape past the fact vocabulary.
- Parse every foreign value from `unknown` with explicit bounds. An unrecognised event becomes a bounded protocol notice, never a silent accept and never a thrown fault on a live session.
- Answer a `can_use_tool` request only by echoing its own `input`. Never send `permission_suggestions`, so HRA can grant nothing beyond `once`.
- Never read, copy, or forward a Claude credential. The authentication boundary is the reviewed isolated `CLAUDE_CONFIG_DIR` for managed profiles or Claude's canonical default-home resolution for the explicitly bound personal profile.
- Sanitize every provider string that can reach a display, projection, or log: absolute paths reduced, credential-shaped runs replaced, unsafe terminal scalars folded.
