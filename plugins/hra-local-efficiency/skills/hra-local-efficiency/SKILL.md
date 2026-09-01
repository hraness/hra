---
name: hra-local-efficiency
description: >-
  Install, audit, and operate the Hraness local Codex efficiency baseline across
  repositories and Macs. Use for Codex swarm throughput, host-wide
  heavyweight-command scheduling, capability lanes, privacy-safe telemetry,
  validation ownership and exact-tree receipts, stale-task reporting, guarded
  Git worktree cleanup, complete-history CI ref isolation, model-lane setup, or
  checking whether a Hraness machine follows the standard. Preserve useful
  agent fan-out and all repository final gates. Do not use for cloud execution
  or cloud optimization.
---

# HRA local efficiency

Keep parallel reasoning. Reduce duplicated validation, conflicting local
compute, unnecessary checkouts, stale state, and verified disposable disk use.

## Choose the mode

- **Install or update this Mac:** run `bun run scripts/bootstrap.ts --apply`
  from this skill directory, then run it again with `--check`.
- **Inspect this Mac:** run `bun run scripts/workspace-audit.ts` and
  `bun run scripts/session-audit.ts`. Both are read-only by default. Add
  `--sizes` only when the slower recursive worktree-size estimate is useful.
- **Measure local throughput:** run `hra-throughput-report` for the bounded,
  privacy-safe scheduler history. Treat repeat command digests and silent tasks
  as review heuristics, never as proof of waste or abandonment.
- **Run heavyweight local work:** resolve `hra-host-run` to its installed
  absolute path and use `ABSOLUTE-HRA-HOST-RUN
  --mode=shared|heavy|exclusive
  --lane=compute|browser-auth|mac-native --label=LABEL -- COMMAND ...` through
  reviewed host access. Keep the complete wrapper and child argv visible to
  Codex.
- **Record or reuse deterministic focused validation:** use `hra-validate`.
  Reuse is opt-in and is never valid for a required final integration,
  merge-queue, deployment, release, authenticated-browser, or network-sensitive
  gate.
- **Reclaim Git worktrees:** audit first with `workspace-audit.ts`, then invoke
  `worktree-cleanup.ts` separately in each owning repository with every approved
  absolute path named through `--remove`.
- **Adopt or check repository guidance:** use `repo-adoption.ts --check` or
  `--apply`. It edits only the exact managed policy block in a root `AGENTS.md`.
- **Audit CI ref isolation:** use `hra-ci-ref-audit --root ABSOLUTE-REPO`. Review
  every candidate; fix only workflows whose complete-history gate can import
  unrelated refs, and preserve the complete-history scan itself.

Run scripts from the installed skill directory when the convenience commands
are unavailable. `bootstrap.ts` installs or refreshes those commands under the
user's Bun bin directory. It verifies a minimal pinned Atet host-resource
runtime in the user's local data directory; it never replaces a global Atet
package or command.

## Preserve the invariants

- Do not cap agent count merely to reduce fan-out. Parallel reasoning and
  independent implementation lanes remain desirable.
- Prefer bounded subagents in the current task for research, review, diagnosis,
  and focused checks when they can safely share one working tree. A separate
  task or worktree is warranted for independently deliverable divergent edits,
  an intentionally isolated verification tree, or a different environment.
- Give each focused check one worker owner. The integrator reviews the diff and
  reported evidence, repeating a focused command only when the tree changed,
  evidence is missing, or a repair invalidated it.
- Give each CI run, merge-queue item, provider operation, or deployment wait one
  waiter. Do not hold a compute lease while waiting on external state.
- Run the repository's aggregate/final gate once after convergence. Never use a
  receipt to skip a repository-required final replayed-tree or delivery gate.
- The host scheduler is an outer layer. Jungle and HRA keep their repository
  schedulers underneath it; invoke `hra-host-run` only around top-level
  commands. Nested `hra-host-run` calls inherit the outer lease and do not
  acquire again.
- Keep roots and integrators on the caller's selected model. Bounded independent
  workers may use the installed `hra-worker` or `hra-routine` profiles when the
  task merits them; measure repair rate rather than assuming cheaper is better.
- This baseline is local-only. Do not create, configure, or route work to Codex
  cloud through this skill.

## Capability lanes

- **Ordinary:** research, review, edits, and narrow checks. Share the current
  task worktree when safe and normally do not acquire a host lease.
- **Heavy compute:** broad builds and repository gates. Use the `compute` lane
  with `heavy` or `exclusive` mode.
- **Browser auth:** work that needs the user's signed-in browser, a fixed port,
  a dev server, or Chromium. Keep it on this machine, assign one owner, and use
  the `browser-auth` lane. Use `exclusive` mode for a fixed-port or heavyweight
  suite.
- **Mac native:** Xcode, Simulator, Keychain, signed-app, or other macOS-only
  work. Keep it on a Mac, assign one owner, and use the `mac-native` lane.

The browser and Mac lanes each serialize their scarce capability while still
sharing the weighted compute capacity. A nested wrapper must be covered by the
outer lane; choose the top-level lane correctly instead of escalating it inside
an existing lease.

For non-interactive macOS and Linux runs, the wrapper supervises a dedicated
child process group and forwards `HUP`, `INT`, `QUIT`, and `TERM` to the whole
group. An interactive TTY preserves its controlling terminal and receives
best-effort leader signaling so an intentional 2FA prompt still works. Do not
detach a background server from scheduler custody.

## Resource modes

Use `shared` for one narrow check, `heavy` for production builds and ordinary
repository-wide checks, and `exclusive` for full monorepo validation, native
packaging, capture hardware, or fixed-port browser suites.

Submit `exclusive` work only after its inputs converge. Strict FIFO prevents
starvation but can strand spare permits behind a waiting all-permit claim. If
that happens ahead of a known finite shared/heavy backlog, only the exclusive
claim's owner may cancel it before admission and requeue the identical command
after the backlog drains. Never interrupt an admitted command just to reorder
the queue, and never run its child outside the scheduler.

Known mappings:

- Jungle `check:affected`: heavy; Jungle full `check`: exclusive.
- HRA `check`: heavy; HRA `check:complete`, production build, and native
  package work: exclusive.
- Personal template and Tiff full check/build: heavy.
- Narrow file or package tests: normally unscheduled.

The wrapper runs the original public command unchanged. It does not substitute
a weaker check.

Each top-level scheduler attempt appends one bounded local telemetry record when
storage is available. A pre-admission scheduler error or catchable cancellation
has no admission timestamp or run duration; cancellation is recorded before the
waiting claim is released. Records contain timestamps, lane, mode, safe label, program
label, permit counts, queue and run durations, an exit class, a hashed workspace
identifier, and a command digest. They never contain raw argv, environment
values, paths, transcripts, reasoning, or tool output. Telemetry is best effort
and never changes the child command's result.

## Host-access boundary

The machine-wide scheduler state intentionally lives outside an ordinary
repository sandbox. Request reviewed host access for the top-level absolute
`hra-host-run` invocation on the first attempt. This also applies to focused
HRA process-custody and recovery tests: they exercise machine-scoped identity
and journal locks even when their CPU cost is small.

If the wrapper reports `HRA_HOST_ACCESS_REQUIRED` and exits 77, retry the
identical wrapper invocation once through Codex host-access approval or
configured auto-review. Preserve the working directory and every argument. If
the reviewed retry still returns 77, stop and diagnose the permission setup.
Never bypass the wrapper by running its child directly, remove scheduler or
recovery state, weaken fail-closed custody, or create an unconditional allow
rule for `hra-host-run`; it can wrap arbitrary child commands.

The bootstrap manages a prompt-only Codex rule for the absolute installed
wrapper. The rule makes every complete invocation reviewable but grants no
permission. Codex loads rule files at task startup, so start a new task after
installing or updating the baseline.

## Validation receipts

`hra-validate` fingerprints the Git HEAD, tracked diff, untracked file content
and executable/link mode, working directory, exact command, Bun/Node versions,
lockfiles, and caller contexts. It never follows untracked symlinks. Successful
receipts live under the repository's Git common directory
so linked worktrees can share exact evidence. Receipts and wrapper output retain
only a safe operation label, program name, and command digest—not raw argv or
context values. Reuse fails closed when the index contains skip-worktree or
assume-unchanged entries, a populated gitlink/submodule, or an unsupported
untracked file type.

Use `--reuse --ttl-minutes=N` only for deterministic focused commands. Force a
real run after relevant environment or external state changes. Failed commands
are reported for diagnosis but never reused as success.

## Complete-history CI

A complete-history policy is not permission to fetch every live branch. Start
from the exact governed SHA, disable credential persistence, and explicitly
fetch only the fully qualified branch, tag, or exact-SHA refs the policy owns.
Enumerate refs immediately afterward and reject any unexpected ref before the
history scan. Keep `rev-list --all` or the repository's equivalent complete
scan over that governed ref set.

Use `hra-ci-ref-audit` as a conservative review aid. A broad fetch without a
complete-history consumer is informational, and a complete-history consumer
with an explicit governed ref set is compliant. Do not rewrite release history
fetches mechanically; tags and the stable branch may both be required inputs.

## Cleanup safety

Size is a discovery signal, not deletion authority. A removable worktree must
be registered, present, clean including untracked and ignored files, free of
skip-worktree and assume-unchanged index flags and populated gitlinks, neither
primary nor the invoking worktree, explicitly named, and merged into an exactly
fetched, fully qualified remote target. The cleanup script validates the full
manifest before deletion and revalidates every target at action time. It never
forces removal or deletes branches.

Treat unregistered temporary directories, Codex transcripts, application
databases, credentials, private corpora, archives, and dirty worktrees as user
state. Never sweep a temporary-path prefix.

At task closeout, record the applicable final branch, pull request, checks,
merge, release, deployment, and production readback. Archive only a
conclusively finished task; silence is not completion evidence. In the Codex
app, archiving a completed managed-worktree task lets the app snapshot and
reclaim its managed checkout. Permanent worktrees still require their own
guarded cleanup.

## Machine standard

`bootstrap.ts` manages one marked block in the global Codex `AGENTS.md`, two
optional CLI profiles, a prompt-only host-access rule, a minimal private
scheduler runtime, and convenience commands. It preserves all content outside
its markers, leaves exact profile symlinks intact, and refuses conflicting
unmanaged targets. Use `--check` in automation and after plugin upgrades.

The HRA repository marketplace is the cross-machine source of truth. Upgrade
the marketplace and reinstall the plugin, then rerun bootstrap and start a new
Codex task so the refreshed skill is discovered.
