# Contents

- `hra-local-efficiency/` contains the marketplace-distributed local Codex efficiency plugin.
- `hra-cloud-efficiency/` contains the marketplace-distributed Codex Cloud repository-worker routing plugin.

# Guidelines

- Keep each plugin self-contained with one matching folder, manifest name, and marketplace entry.
- Keep repository plugins outside the published `@hraness/hra` package and independently versioned.
- Keep `hra-local-efficiency` local-only. Do not add cloud execution, cloud routing, or provider credentials to it.
- Keep `hra-cloud-efficiency` separate from HRA hosted or Convex operations. It may qualify and launch Codex Cloud repository work through documented commands, but it must not store provider credentials or implement a private Cloud client.
- Keep implementation rules in the closest plugin or skill guide.
