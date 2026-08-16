# Contents

- `apps/` – the HRA macOS desktop, web control plane, and `taskctl` CLI workspaces.
- `packages/` – shared task, client, interface, and repository-support packages.
- `scripts/` – public-boundary, standalone structure, agent-guide, asset, resource-scheduling, and Direct checks.
- `.github/workflows/` – credential-free source, test, and build verification.
- `README.md` – product overview, repository map, development setup, and verification commands.
- `SECURITY.md` and `SECURITY_ARCHITECTURE.md` – vulnerability reporting and the public product security model.
- `CONTRIBUTING.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `TRADEMARKS.md` – contribution, licensing, attribution, and mark-use terms.

# Guidelines

- Treat this directory as the complete HRA Bun workspace. Every source dependency must resolve from this repository, the checked lockfile, or a named public upstream.
- Use Bun 1.3.14 and Node 24. Do not add another package manager or lockfile.
- Keep product packages under `@hraness/hra-*`, neutral task packages under `@hraness/agent-tasks-*`, and repository-support packages under `@hra-internal/*`.
- Consume `@hraness/codex-app-sdk` from the exact public commit in the root catalog. Do not add a workspace copy of that separately maintained SDK.
- Treat persisted identifiers, cryptographic namespaces, updater contracts, and Keychain services as explicit protocol decisions. This project is prerelease, so a deliberate breaking change is acceptable when its storage and recovery effects are covered by deterministic tests.
- Keep provider account and Codex runtime custody in the installed desktop app. Keep multi-tenant task authority, subscriptions, and human administration in the web app.
- Keep the CLI a versioned API consumer. It must not import Convex server implementation or generated data-model types.
- Keep `taskctl`, its configuration names, and its credential custody product-neutral.
- Preserve third-party license and notice files beside vendored source or assets. Update `THIRD_PARTY_NOTICES.md` when a bundled dependency, runtime, font, or artwork changes.
- Keep public GitHub workflows read-only. Pin third-party actions to full commit SHAs, persist no checkout credential, use no repository secrets, and upload no release artifact.
- Follow `WRITING.md` and `STYLE.md` for public documentation. State compatibility and affiliation accurately, and keep operational credentials, provider mutation, and signing custody out of this repository.
- Run focused checks while editing. Run `bun run check:agent-guides` after guide changes and `bun run check` before handoff. Run `bun run check:complete` for production-build changes.
