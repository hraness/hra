# Contents

- Pin holds the one exact Claude Code version, Fable model id, reasoning effort, and reviewed stream-json matrix digests.
- Runtime discovery locates and version-admits the pinned `claude` executable and builds its exact argv.
- Process spawns that executable with the same environment allowlist Codex uses. Managed profiles set a reviewed absolute `CLAUDE_CONFIG_DIR`; the explicitly bound personal profile omits that variable so Claude resolves its canonical default home itself. The runtime profile records which mode was used.
- Protocol parses every stream-json line from `unknown` into a closed union and maps `can_use_tool` onto HRA interaction kinds.
- Assembler is the delta assembler: it owns turn, item, and subagent identity and emits the closed fact vocabulary the runtime consumes.
- Client is the public Promise facade for one process. Session-model holds closed types, session-platform adapts native observations, session-program owns lifecycle composition, and session-effects contains the prepared connection interpreter shared with manager acquisition.

# Guidelines

- Pin one exact Claude Code version. The stream-json surface is not a published contract, so refuse any other build and re-capture `docs/providers/claude-fixtures/` before changing the pin.
- Keep the split the bridge captures: this layer knows Claude's dialect, the daemon knows the timeline. Never leak a Claude wire shape past the fact vocabulary.
- Parse every foreign value from `unknown` with explicit bounds. An unrecognised event becomes a bounded protocol notice, never a silent accept and never a thrown fault on a live session.
- Answer a `can_use_tool` request only by echoing its own `input`. Never send `permission_suggestions`, so HRA can grant nothing beyond `once`.
- Internal manager programs compose client programs on the same connection owner. Keep native initialization arbitration explicit, retain pending native work through bounded close failure, and never dispose a borrowed acquisition owner from child cleanup.
- Never read, copy, or forward a Claude credential. The authentication boundary is the reviewed isolated `CLAUDE_CONFIG_DIR` for managed profiles or Claude's canonical default-home resolution for the explicitly bound personal profile.
- Keep the pinned Fable-to-Opus native fallback unavailable until one sanitized authenticated acceptance record proves the exact pinned version, both model ids, max effort, and combined argv. Help output, binary strings, a global Claude login, and unauthenticated output are not acceptance evidence.
- Never rotate a Claude account automatically or restart, resume, or replay a turn to simulate model fallback. Only an admitted pinned runtime may add the provider-native fallback argument before process start.
- Sanitize every provider string that can reach a display, projection, or log: absolute paths reduced, credential-shaped runs replaced, unsafe terminal scalars folded.
