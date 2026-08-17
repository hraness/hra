# Contents

- `src/` – the framework-neutral client host, immutable coordinates, lifecycle fences, operation registry, persistence contracts, reducer store, optional React selector adapter, and deterministic testing adapters imported from the public Codex App SDK v0.1.1 source.
- `contract/` – package-boundary regression tests for the three supported import subpaths.
- `LICENSE` and `PROVENANCE.md` – retained MIT terms and the exact source snapshot record.
- `package.json`, `tsconfig.json`, and `eslint.config.mjs` – the private source-first workspace surface and shared HRA verification configuration.

# Guidelines

- Keep this package headless, provider-neutral, and independent from HRA product workspaces; provider protocol adapters and concrete persistence belong to consumers.
- Preserve the root, `react`, and `testing` subpaths. Keep React optional and isolated behind `./react`, and keep deterministic adapters behind `./testing`.
- Treat client projections, mutation attempts, source coordinates, and generations as explicit immutable contracts. Reject stale generations and invalid foreign values rather than repairing them implicitly.
- Preserve readable regressions and property tests for reducer, ordering, lifecycle, persistence, and round-trip laws.
- Retain the MIT license and snapshot provenance with this source. Do not describe the package as Apache-2.0 or remove its license from packaged desktop notices.
