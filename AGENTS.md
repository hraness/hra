# Contents

- `src/` contains the Bun CLI, daemon, local authority, Codex adapter, and cloud client.
- `convex/` contains the optional encrypted sync and verified-email device authority.
- `site/` contains the static public website generated from the README content contract.
- `scripts/` contains deterministic checks, builds, and release helpers.
- `kb/` contains maintained product knowledge and executable implementation plans.
- `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `WRITING.md`, and `STYLE.md` define the public product and contribution contract.

# Guidelines

- Keep HRA one small Bun product. Add a package boundary only for a concrete second consumer.
- Pin Bun to 1.3.14. Use one `bun.lock`; do not add another package manager or lockfile.
- Codex app-server owns provider authentication, transcripts, turns, tools, and approvals. HRA owns isolated profiles, process generations, commands, local projections, encrypted sync, and recovery.
- Parse every foreign value from `unknown`. Expose closed domain operations instead of a generic JSON-RPC, HTTP, filesystem, or shell escape hatch.
- Record every mutation before dispatch, bind it to an idempotency key and exact authority generation, and reconcile an uncertain result without speculative replay.
- Keep provider credentials, raw reasoning, environment values, arbitrary tool output, approval secrets, and unbounded paths out of cloud sync, logs, JSON output, and receipts.
- Treat one machine as the fenced execution custodian for a session. Other devices may read or submit durable commands; they may not create a second provider writer.
- Account selection is user-directed. Never rotate subscriptions to bypass a provider limit or replay a failed turn under another account automatically.
- Keep `--json` stable and machine-readable. Write data to stdout and diagnostics to stderr. Use closed exit codes and bound every input, output, timeout, page, queue, and retry.
- Colocate deterministic examples with each failure mode and property tests with parsers, reducers, ordering, state transitions, and round trips.
- Give each owned source boundary an `AGENTS.md` with exactly `# Contents` and `# Guidelines`.
- Follow `WRITING.md` for repository prose and `STYLE.md` for public copy. Keep README and website claims byte-derived from one content source.
- Update the active plan in `kb/plans/` as work changes. Do not call a phase complete without the acceptance evidence named there.
- Preserve public independence. Do not include private paths, credentials, private package dependencies, internal project names, or unpublished provenance.
