<!-- kb:context scopes/apps-desktop-runtime--ca7b731d583e -->
# Contents

- `src/` – the compiled Bun gateway, account routing, durable supervision, projection, persistence, security, and workspace implementation.
- `test/` – deterministic fake app-servers, fault fixtures, protocol probes, property suites, and gateway integration tests.
- `run-native.ts` – the development launcher that resolves exact local Codex and Git paths before starting the Zig host.
- `dev-protocol.ts` and `dev-supervisor.ts` – localhost ownership, readiness, launch ordering, environment scrubbing, and bounded process cleanup.
- `run-zig.ts` and `zig-toolchain.ts` – shared Zig launch and deterministic executable discovery for native commands.
- `verify-runtime-pins.ts` and `runtime-versions.json` – portable package metadata checks and explicit Apple Silicon runtime hashes.
- `generate-codex-schema.ts` – pinned Codex schema generation and checked-source verification.
- `frontend-package-integrity.ts` and `prepare-package-output.ts` – deterministic frontend asset validation used by the native build graph.
- `control-plane-maintenance.ts` – app-stopped health checks plus encrypted backup, inspection, verification, and restore.
- `reactive-baseline.ts` – the owned gateway, projection, SQLite, Direct bridge, React, containment, and cleanup baseline.
- `THIRD_PARTY_NOTICES.md` and adjacent license texts – notices for the pinned runtimes used by desktop builds.

# Guidelines

- Keep this directory inside the desktop workspace. It intentionally has no nested manifest or lockfile.
- Compile the gateway into a standalone executable. An installed source build must not fall back to global Bun, Node, Python, Codex, Git, or a shared home.
- Use a distinct unminified, inline-source-mapped gateway for local development. Do not restart it automatically while it may own an active task.
- Keep repository checks platform-neutral. Execute pinned Apple Silicon binaries only through explicit macOS commands.
- Keep one serialized JSONL writer per account child and correlate every request by account profile, durable process generation, and JSON-RPC ID.
- Pass each child only its validated account `CODEX_HOME` and allowlisted environment.
- Page immutable snapshots that exceed Native's response limit. Replace oversized recoverable events with `snapshot.invalidated`; never discard terminal or human-in-the-loop events to make them fit.
- Keep the gateway as the semantic proxy. Native owns launch, lifecycle, trusted directory selection, and transport plumbing.
- Recovery-only local-data removal startup may resume only its strict recovery state machine. It must not open normal application writers.
- Keep release signing, notarization, official artifact verification, provider writes, and publication code outside the public source workspace.
