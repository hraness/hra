# HRA local efficiency plugin

The repository marketplace distributes `hra-local-efficiency`, a local-only Codex plugin for managed Codex and Claude Code approval defaults, repository delivery guidance, machine-wide heavyweight-command scheduling, capability lanes, privacy-safe throughput telemetry, validation ownership, complete-history CI ref audits, stale-task review, and guarded worktree cleanup. It preserves useful agent fan-out and every repository final gate while avoiding unnecessary approval and checkout churn. It does not configure or route cloud execution.

The plugin is separate from the published `@hraness/hra` package. Install the repository marketplace and plugin on each development machine. The marketplace checkout includes the complete `plugins/` directory so it can also distribute the separate [HRA Cloud efficiency plugin](cloud-efficiency-plugin.md):

```sh
codex plugin marketplace add hraness/hra --ref main --sparse .agents/plugins --sparse plugins
codex plugin add hra-local-efficiency@hraness
```

Start a new Codex task after installation so Codex discovers the skill. Ask it to install the HRA local efficiency baseline on the Mac. The skill applies marker-bounded global Codex and Claude guidance, sets Codex to on-request approval with automatic review and the workspace permission profile, and sets Claude Code to Auto mode with its built-in classifier defaults retained after a capability probe succeeds. When entering Auto mode it removes bare or universal whole-tool allows and every wildcarded Bash or PowerShell allow such as `Bash(gh *)`, because explicit allow rules resolve before Auto's classifier; exact command rules, path-bounded non-shell rules, and every deny remain in the configuration. Claude may apply its own additional runtime filtering when Auto starts. It installs the scheduler, report, audit, and optional worker-profile commands, verifies a minimal private scheduler runtime, and adds one marker-bounded prompt rule under the Codex rules directory for the absolute installed `hra-host-run` command. Unrelated TOML, JSON, Markdown, rules, and global Bun packages remain unchanged.

This baseline records the user's standing authority once: task-owned commits, pushes, pull requests, merges, tags, releases, deployments, and verification proceed through the repository's required gates without another conversational confirmation. It does not bypass a runtime denial, invent missing credentials, weaken branch or environment protection, or turn an out-of-scope destructive action into routine work.

The host rule deliberately uses `prompt`, never `allow`: `hra-host-run` can carry arbitrary child argv. A top-level scheduled command must therefore keep the absolute wrapper and complete child command visible while requesting reviewed host access. Codex auto-review can review that boundary without a human pause, but neither the rule nor auto-review expands the sandbox by itself. Codex loads configuration and rules at task startup, so start another new task after bootstrap installation or update.

Claude Code Auto mode requires Claude Code 2.1.83 or later and an eligible account, model, and organization setting. Before any write, the bootstrap checks the CLI version and requires `claude auto-mode config` to return a bounded valid configuration. That command proves the local CLI/configuration surface, not account, model, or organization eligibility; Claude Code enforces those conditions when a session starts. The managed `autoMode.environment` contains only `$defaults`, so upstream safeguards update without globally treating sibling Hraness repositories or the public npm registry as internal. The permission migration is applied only when that capability probe succeeds; otherwise bootstrap leaves the ordinary mode and its allow rules untouched and reports why. If the runtime eligibility gate refuses Auto mode, use the ordinary permission mode; never substitute bypass permissions.

Inspect the complete machine baseline without changing it:

```sh
hra-local-efficiency --json
```

The doctor reports the Codex and Claude guidance/configuration drift, command links, pinned scheduler runtime, and Claude Auto-mode CLI/configuration capability. Run `hra-workspace-audit` separately for repository adoption state and `hra-session-audit` for privacy-safe interruption evidence.

If a sandboxed or incompletely permitted wrapper reaches machine-wide state, it fails before child execution with `HRA_HOST_ACCESS_REQUIRED` and exit 77. Retry that identical wrapper invocation once with reviewed host access. Do not run the child directly, delete scheduler or HRA recovery locks, or weaken fail-closed custody. A repeated exit 77 is a permission-configuration failure to diagnose, not cleanup authority.

Use the compute lane for ordinary scheduled work. Use one `browser-auth` owner for authenticated browser, fixed-port dev-server, or Chromium work, and use `mac-native` only for work that actually requires macOS:

```sh
hra-host-run --mode=heavy --lane=compute --label=repo-check -- bun run check
hra-host-run --mode=exclusive --lane=browser-auth --label=browser-suite -- bun run test:e2e
hra-host-run --mode=heavy --lane=mac-native --label=native-check -- xcodebuild test
```

The browser capability is serialized separately before weighted CPU admission, so it does not consume a compute permit while waiting. The Mac lane fails before child execution on another operating system. Nested wrappers may use only a mode and capability already covered by the outer lease.

The weighted coordinator is strict FIFO for overlapping claims. Queue `exclusive` only for a converged command that is ready to run. If a never-admitted exclusive claim strands spare permits ahead of a known finite shared/heavy backlog, only its owner may cancel that waiting wrapper and requeue the identical command after the backlog drains. Do not interrupt admitted work or bypass the scheduler to reorder it.

For non-interactive macOS and Linux runs, the wrapper gives the command its own process group, forwards `HUP`, `INT`, `QUIT`, and `TERM` to that complete group, and terminates residual descendants when the command leader exits. Residual processes receive a bounded graceful interval before forced cleanup. An interactive TTY keeps its controlling terminal and receives best-effort leader signaling. This keeps interrupted package runners and browser suites from continuing outside their scheduler lease without breaking an intentional 2FA prompt; an uncatchable host-level kill still requires operating-system recovery and diagnosis.

Each top-level scheduler attempt records one bounded event when telemetry storage is available; pre-admission scheduler failures and cancellations have no admitted timestamp or run duration. A catchable cancellation is recorded as `canceled` with its conventional signal exit code before the wrapper releases its waiting claim. Daily files are mode `0600` below a mode-`0700` directory, are capped at 4 MiB, and retain fourteen UTC days. Records include safe labels, digests, timings, lane, mode, permits, and outcome. They exclude raw argv, paths, environment values, process identities, transcripts, reasoning, and tool output. Telemetry is best effort and never changes the wrapped command's result.

Review the first seven days of available local measurements with:

```sh
hra-throughput-report
hra-throughput-report --days=14 --json
```

The report shows queue and run percentiles, failures, permit-weighted runtime, concurrency, and repeated command digests. Repeats are review candidates, not proof of wasted work. Measurements begin after this plugin version is installed; the plugin does not reconstruct historical telemetry from private transcripts.

Audit a repository's history-fetch posture with:

```sh
hra-ci-ref-audit --check --root /absolute/repository/path
```

The audit is read-only. It rejects an unbounded ref fetch coupled to a detected complete-history consumer, recognizes explicit exact-ref allowlists, and leaves uncertain broad-history cases for review. It never rewrites workflows or weakens `rev-list --all` and equivalent policy gates.

From a reviewed repository checkout, maintainers can apply and verify the same bootstrap directly:

```sh
bun run local-efficiency:apply
bun run local-efficiency:check
```

After a marketplace update, refresh the Git snapshot, reinstall the plugin, and start another new task:

```sh
codex plugin marketplace upgrade hraness
codex plugin add hra-local-efficiency@hraness
```

Machines that installed the earlier plugin-specific sparse checkout must replace that marketplace snapshot once before upgrading:

```sh
codex plugin marketplace remove hraness
codex plugin marketplace add hraness/hra --ref main --sparse .agents/plugins --sparse plugins
codex plugin add hra-local-efficiency@hraness
```

In that new task, invoke `$hra-local-efficiency` and have it run the freshly installed skill's `scripts/bootstrap.ts --apply` followed by `--check`. This repoints the convenience-command symlinks from the prior versioned plugin cache before they are used and refreshes the prompt-only host-access rule.

Run the plugin's deterministic test suite before handoff:

```sh
bun run test:local-efficiency-plugin
```

The bootstrap and audits are local operations. The read-only workspace audit reports managed-guidance drift alongside the existing Hraness repository and worktree inventory. Repository adoption changes only the exact `hra-local-efficiency` marker block in root `AGENTS.md`; it creates root `CLAUDE.md` as `@AGENTS.md` when missing, preserves an existing active import byte-for-byte, or adds a marker-bounded import without replacing Claude-specific guidance. The managed policy keeps bounded research and review subagents in one working tree when safe, creates another worktree only for genuinely divergent delivery, assigns one owner to each focused check and external wait, prefers short-lived workload identities to personal credentials, and records final delivery evidence before closeout.

Session silence remains a review heuristic. The audit never writes the Codex database or infers completion from inactivity or support-task metadata. Verify terminal task state through the app, then archive a conclusively finished task so the app can snapshot and reclaim its managed checkout. Permanent worktrees and other registered checkouts still require the separate explicit cleanup operation with every approved absolute path.
