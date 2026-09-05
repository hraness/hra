# Contents

- `src/` contains the Bun CLI, daemon, local authority, Codex and Claude Code adapters, and cloud client.
- `convex/` contains the optional encrypted sync and verified-email device authority.
- `site/` contains the static public website generated from the README content contract.
- `scripts/` contains deterministic checks, builds, and release helpers.
- `kb/` contains maintained product knowledge and executable implementation plans.
- `.agents/skills/` contains the portable five-skill phased planning and execution pack.
- `.agents/plugins/` contains the repository marketplace catalog.
- `plugins/hra-local-efficiency/` contains the local-only Codex efficiency plugin and its operating skill.
- `plugins/hra-cloud-efficiency/` contains the Codex Cloud repository-worker routing plugin and its operating skill.
- `docs/attachments.md` documents message file and image attachments end to end, including the contract a browser client follows.
- `docs/local-efficiency-plugin.md` documents cross-machine marketplace installation and maintainer validation.
- `docs/cloud-efficiency-plugin.md` documents Cloud routing, environment profiles, installation, and pilot operation.
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

<!-- hra-local-efficiency:start -->
- Treat the user's request to change this repository as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, deployments, and production verification after the repository's required validation, review, identity, and rollout gates pass. Do not ask for another confirmation at each delivery step.
- Use the repository's documented delivery workflow and preserve every runtime-enforced approval, branch protection, environment rule, safety policy, and final gate. Ask for user input only when delivery needs a material product decision, missing credentials or authority, an irreversibly destructive action outside task scope, or resolution of a release failure that cannot be handled safely and autonomously.
- Prefer short-lived repository workload identities such as OIDC trusted publishing, GitHub Apps, and narrowly scoped machine identities. Do not add long-lived personal tokens, weaken two-factor authentication, or bypass provider controls to eliminate an interactive prompt. Batch unavoidable human-gated production promotions into intentional stable releases while agents publish validated prerelease or beta channels through workload identities when the repository supports them.
- Preserve useful reasoning fan-out, but avoid unnecessary checkout fan-out. Prefer subagents in the current task for bounded research, review, diagnosis, and focused checks when they can safely share one working tree; create a separate task or worktree only for independently deliverable divergent edits, an isolated verification tree, or a different execution environment.
- Give each expensive focused validation command and external wait one owner. The integration owner reviews that evidence and runs the repository-required aggregate or final gate once after convergence. Reuse evidence only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and validity period, and never to skip a required final integration, merge, release, deployment, or production-verification gate.
- On Hraness development machines, use `$hra-local-efficiency` and the installed host scheduler for heavyweight top-level commands when available. Keep ordinary work in the compute lane; give authenticated browser/dev-server/Chromium work one `browser-auth` owner and Mac-only validation one `mac-native` owner.
- When a CI or policy gate scans complete Git history, check out the exact governed SHA and fetch only the fully qualified governed refs before scanning. Preserve the complete-history gate and reject unexpected refs instead of importing unrelated concurrent heads.
- At closeout, record applicable branch, PR, check, merge, release, deployment, and production evidence. Archive only conclusively finished tasks, never from silence alone, and reclaim only freshly revalidated clean merged worktrees through the guarded exact-path flow.
<!-- hra-local-efficiency:end -->

<!-- hra-cloud-efficiency:start -->
- Use `$hra-cloud-efficiency` only for bounded Codex Cloud repository work from an exact pushed branch. Keep the root integrator on the caller-selected model and record the worker as `cloud-default`.
- Keep authenticated browser, interactive auth, 2FA, private local data, Mac-native, signing, release, deployment, production, agent-phase secret, agent-phase network, and exact-model work on its authoritative local or CI lane.
- Give every editable Cloud task one unique branch and owner. Cloud workers may run focused validation but may not merge, weaken gates, release, deploy, or replace the repository's final exact-tree validation.
<!-- hra-cloud-efficiency:end -->
