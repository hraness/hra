# Contents

- `human-client/` – product-private optional human authentication, strict typed HTTP transport, refresh coordination, and secret-custody contracts shared by the CLI and desktop gateway.
- `internal/` – repository-support packages for Codex client state, schemas, testing, storage, design, and shared configuration.
- `local-observation-protocol/` – strict pathless attention, pane-summary, and owner-private read-channel contracts shared by the desktop gateway and local `hra` CLI.
- `task-domain/` – leaf provider-neutral task identity, authority, commands, projections, promotion contracts, and pure laws shared by cloud and local adapters.
- `task-protocol/` – product-private task wire validators, actor types, scopes, errors, and transport contracts layered on the task domain.
- `task-ui/` – provider-neutral React task presentation, state/action ports, fixtures, styles, and verification shared by hosted web and local desktop.

# Guidelines

- Add a package only when at least two HRA workspaces consume its behavior.
- Keep `@hra-internal/codex-app-sdk` provider-neutral and source-first. Preserve its root, React, and testing subpaths, and retain its MIT license and snapshot provenance.
- Keep generated Convex types, database implementation, desktop runtime code, and CLI storage out of product-private packages.
- Keep `@hraness/hra-human-client` portable across the CLI and compiled desktop gateway; provider tokens remain behind its custody ports and never enter renderer, SQLite metadata, or diagnostics.
- Keep `@hraness/hra-local-observation-protocol` content-free and pathless. It may carry aggregate task counts and opaque revision-bound setup coordinates, but never task details, prompts, queue text, transcripts, commands, output, credentials, or mutation authority.
- Reusable React UI is allowed only in a provider-free package consumed by at least two product apps; keep Next.js, Convex, identity-provider SDKs, Native, SQLite, filesystem, generated APIs, and authority adapters outside its production graph.
- Retain `@hraness/agent-tasks-protocol` as the package name during the family migration; rename it only through an explicit versioned contract migration.
- Keep `@hraness/agent-tasks-domain` dependent only on `@hra-internal/schema`; protocol re-exports its portable contracts for compatibility while transport, cloud tenancy, and provider adapters stay outside the leaf.
- Keep fixtures behind explicit non-root subpath exports so production imports cannot reach deterministic examples accidentally.
- Promote code to root `packages/*` only after a second HRA workspace has a concrete use.
