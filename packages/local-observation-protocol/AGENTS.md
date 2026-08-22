# Contents

- `src/` – strict pathless attention, pane-summary, and local read-channel contracts shared by the desktop gateway and desktop-owned `hra` CLI.
- `package.json`, `tsconfig.json`, and `eslint.config.mjs` – the private workspace package boundary and focused checks.

# Guidelines

- Keep this package leaf-like and product-specific. It may depend on portable task identifiers and the shared schema package, but never on desktop runtime, renderer, Native, Convex, or CLI implementations.
- Expose only minimized, pathless, content-free local observation. Never add queue text, prompts, responses, reasoning, attachments, commands, output, canonical paths, provider or session identifiers, account identity, credentials, setup transcripts, or task details.
- Parse every foreign value from `unknown`, reject unknown keys, cap every collection and string, and require unique canonically ordered attention items.
- Keep the local read capability separate from every mutation authority. A future writer protocol requires a separate security design and must not extend this credential.
