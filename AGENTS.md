<!-- kb:context scopes/repository--cdb4ee2aea69 -->
# Contents

- `apps/` – the HRA macOS desktop, web control plane, and `taskctl` CLI workspaces.
- `packages/` – shared task, client, interface, and repository-support packages.
- `scripts/` – public-boundary, standalone structure, agent-guide, asset, resource-scheduling, and Vercel deploy-selection checks.
- `.agents/skills/` – portable repository orchestration and knowledge-base workflows.
- `kb/` – the public-safe Git-backed Markdown vault for rationale, evidence, maintained synthesis, plans, and scoped agent context.
- `.github/workflows/` – credential-free source, test, build, and ad-hoc package verification.
- `README.md` – product overview, repository map, development setup, and verification commands.
- `SECURITY.md` and `SECURITY_ARCHITECTURE.md` – vulnerability reporting and the public product security model.
- `CONTRIBUTING.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `TRADEMARKS.md` – contribution, licensing, attribution, and mark-use terms.
- `WRITING.md` and `STYLE.md` – internal and public prose contracts.

# Guidelines

- Treat this directory as the complete HRA Bun workspace. Every source dependency must resolve from this repository, the checked lockfile, or a named public upstream.
- Follow `WRITING.md` for internal prose and `STYLE.md` for public prose, preserving facts, exact terms, literals, quotations, links, and necessary uncertainty. State compatibility and affiliation accurately, and keep operational credentials, provider mutation, and signing custody out of this repository.
- Apply unreasonably robust programming when agent work is cheap. Prefer coherent cross-file correctness and focused deterministic evidence while treating production risk, provider coordination, rollout, and observation as real costs.
- Deliver changes to `main` through a current-head pull request. Keep the stable `Required` CI job green, resolve every review thread, and serialize merges. Human approval stays optional while one regular maintainer would otherwise self-review. Never force-push or bypass the gate.
- Model invalid states out and parse foreign values from `unknown`. Keep readable regression examples; add property tests for laws, parsers, reducers, ordering, and round trips, and promote shrunk failures into named examples.
- Never depend on sibling paths, Git submodules, or coordinated `main` branches. Consume external Hraness packages only through reviewed immutable release tags or commits.
- Extract a shared package only after a second concrete consumer proves a stable product-neutral contract. Shared packages never import HRA products.
- Preserve HRA's internal design packages and product composition. Use `@hraness/ui` for portable accessible primitives; treat public `@hraness/design-kit` as optional and do not replace HRA-owned presentation without concrete reuse.
- Freeze shared interfaces before parallel lanes begin. Give one integration owner manifests, lockfiles, public-tree registries, generated assets, and other convergence files, then let consumers upgrade immutable releases independently.
- Keep mandatory edit-time rules in the closest `AGENTS.md`, current procedures in repository documentation, executable contracts in types, schemas, and tests, and public-safe rationale, evidence, synthesis, and plans in `kb/`. KB lanes run `bun run kb:check:lane`; the integrator performs one refresh and `bun run kb:check`.
- Use Bun 1.3.14 and Node 24. Do not add another package manager or lockfile.
- Keep product packages under `@hraness/hra-*`, neutral task packages under `@hraness/agent-tasks-*`, and repository-support packages under `@hra-internal/*`.
- Use `@hra-internal/codex-app-sdk` for provider-neutral client state, command, persistence, React selection, and deterministic test contracts shared by desktop, web, and task UI. Keep provider adapters and concrete storage in consumers.
- Treat persisted identifiers, cryptographic namespaces, updater contracts, and Keychain services as explicit protocol decisions. This project is prerelease, so a deliberate breaking change is acceptable when its storage and recovery effects are covered by deterministic tests.
- Keep provider account and Codex runtime custody in the installed desktop app. Keep multi-tenant task authority, subscriptions, and human administration in the web app.
- Keep the CLI a versioned API consumer. It must not import Convex server implementation or generated data-model types.
- Keep `taskctl`, its configuration names, and its credential custody product-neutral.
- Preserve third-party license and notice files beside vendored source or assets. Update `THIRD_PARTY_NOTICES.md` when a bundled dependency, runtime, font, or artwork changes.
- Keep public GitHub workflows read-only. Pin third-party actions to full commit SHAs, persist no checkout credential, use no repository secrets, and upload no release artifact. The source workspace may build and verify an ad-hoc-signed macOS package, but Developer ID signing, notarization, and publication require separately provisioned release custody.
- Run focused checks while editing. Run `bun run check:agent-guides` after guide changes and `bun run check` before handoff. Run `bun run check:complete` for production-build changes.
