<!-- kb:context scopes/apps-desktop-runtime--ca7b731d583e -->
# Contents

- `src/` – the compiled Bun gateway, account routing, durable supervision, projection, persistence, security, and workspace implementation.
- `test/` – deterministic fake app-servers, fault fixtures, protocol probes, property suites, and gateway integration tests.
- `run-native.ts` – the development launcher that resolves exact local Codex and Git paths before starting the Zig host.
- `dev-protocol.ts` and `dev-supervisor.ts` – localhost ownership, readiness, launch ordering, environment scrubbing, and bounded process cleanup.
- `dev/` – the path classifier, bounded development-status protocol, Vite watcher, staged gateway builder, and candidate apply reservation.
- `run-zig.ts` and `zig-toolchain.ts` – shared Zig launch and deterministic executable discovery for native commands.
- `verify-runtime-pins.ts` and `runtime-versions.json` – portable package metadata checks and explicit Apple Silicon runtime hashes.
- `shipped-javascript-licenses.ts` – fail-closed, overinclusive production dependency inventory with nested license text and reviewed package exceptions.
- `generate-codex-schema.ts` – pinned Codex schema generation and checked-source verification.
- `frontend-package-integrity.ts` and `prepare-package-output.ts` – deterministic frontend asset validation used by the native build graph.
- `package-macos.ts`, `verify-macos-package.ts`, `create-dmg.ts`, and `corresponding-sources.ts` – credential-free runtime staging, inside-out ad-hoc signing, package verification, DMG assembly, and full-commit GPL/LGPL source archives.
- `test/image-normalizer.macos.test.ts` – macOS-only container, orientation, metadata, bounds, filesystem-race, deterministic-output, and code-signing regressions for the bundled image normalizer.
- `control-plane-maintenance.ts` – app-stopped health checks plus encrypted backup, inspection, verification, and restore.
- `installation-handoff.ts`, `installation-path-authority.ts`, and `installation-process-authority.ts` – the fail-closed OPRTE-to-HRA application handoff, resumable committed cleanup, exact filesystem authority, ordered native-root shutdown, and unchanged-state rollback.
- `release-download-contract.ts`, `release-provenance.ts`, and `release-download.json` at the repository root – strict candidate/publication evidence and hermetic canonical Git provenance for downloadable releases.
- `reactive-baseline.ts` – the owned gateway, projection, SQLite, Direct bridge, React, containment, and cleanup baseline.
- `THIRD_PARTY_NOTICES.md` and adjacent license texts – exact notices and provenance for pinned Bun, Codex, ripgrep, Git, Git LFS, Git Credential Manager, JavaScript, and asset runtimes.

# Guidelines

- Keep this directory inside the desktop workspace. It intentionally has no nested manifest or lockfile.
- Compile the gateway into a standalone executable. An installed source build must not fall back to global Bun, Node, Python, Codex, Git, or a shared home.
- Use a distinct unminified, inline-source-mapped gateway for local development. Do not restart it automatically while it may own an active task.
- Compile changed development gateways beside the live executable and promote only a successful, latest, same-filesystem candidate. A failed or superseded build must leave the running generation and stable executable unchanged.
- Keep executable runtime changes cold. Admit only strictly parsed, bounded data to development gateway apply after proving its cold renderer owns no boot-time, persistence, process, network, provider, or filesystem authority.
- Reserve one staged candidate before hot apply and freeze the stable gateway path through generation recovery. Only the current gateway may seal admission and report itself idle; acknowledge the candidate after the exact replacement generation is ready.
- Keep repository checks platform-neutral. Execute pinned Apple Silicon binaries only through explicit macOS commands.
- Keep one serialized JSONL writer per account child and correlate every request by account profile, durable process generation, and JSON-RPC ID.
- Pass each child only its validated account `CODEX_HOME` and allowlisted environment.
- Page immutable snapshots that exceed Native's response limit. Replace oversized recoverable events with `snapshot.invalidated`; never discard terminal or human-in-the-loop events to make them fit.
- Keep the gateway as the semantic proxy. Native owns launch, lifecycle, trusted directory selection, and transport plumbing.
- Recovery-only local-data removal startup may resume only its strict recovery state machine. It must not open normal application writers.
- Keep Developer ID signing, notarization, provider writes, and publication code outside the public source workspace. Ad-hoc packaging must remain credential-free, preserve trusted upstream signatures, sign HRA code inside-out, and keep Sparkle disabled.
- Stage `hra-image-normalizer` as entitlement-free HRA-owned code in every macOS package shape. Bind its SHA-256 and CodeDirectory hash into the runtime manifest, verify its exact identifier and empty entitlement set in both the app and mounted DMG, and never weaken nested verification to accommodate another runtime.
- Reconcile image-normalizer residue before opening attachment state: remove only exact `.hra-image-normalizer-<32 lowercase hex>.tmp` sibling directories through no-follow descriptor-relative traversal. Never promote temp residue. Treat a missing final generation as uncommitted, and accept an existing final generation only when its exact two-file inventory, identities, sizes, and SHA-256 values match the durable receipt.
- Inventory the installed frontend and gateway production dependency closure, including nested license files. Fail packaging on missing identity, version, license metadata, text, unexpected file types, UTF-8 BOMs, or hash drift; every defective upstream tarball needs an exact version-bound reviewed exception and provenance.
- Inventory Bun and Codex native closures separately from JavaScript. Bind every shipped Codex payload, target Cargo package, source-built native component, Bun build input, and locked Cargo package to exact license documents. Make missing upstream documents explicit with reviewed, identity-bound evidence; never invent attribution.
- Treat Bun/WebKit and Git/Dugite Native corresponding source as release-blocking. The Bun archive must include every pinned native build input, nested Git source, downloaded header archive, and locked Cargo package. Bind upstream commits, exact declarations, archive roots, safe entry types and symlink targets, license/build sentinels, bytes, and SHA-256 evidence. Never publish the native DMG without all four source archives beside it.
