# Contents

- `hra-local-efficiency/` contains the marketplace-distributed local Codex efficiency plugin.

# Guidelines

- Keep each plugin self-contained with one matching folder, manifest name, and marketplace entry.
- Keep repository plugins outside the published `@hraness/hra` package and independently versioned.
- Preserve the local-only boundary. Do not add cloud execution, cloud routing, or provider credentials.
- Keep implementation rules in the closest plugin or skill guide.
