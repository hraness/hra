---
title: One workflow prompt for local and cloud task dispatch
description: Give local and cloud task dispatch the same deterministic built-in prompt without weakening HRA's durable authority or recovery model.
type: plan
area: task-orchestration
status: in-progress
tags:
  - orchestration
  - codex
  - workflow-prompt
repository_scopes:
  - apps/desktop/runtime/src/dispatch
  - apps/desktop/runtime/src/state/local-run-execution-store.ts
  - apps/desktop/runtime/test
---

# One workflow prompt for local and cloud task dispatch

## Outcome

Every local and cloud task dispatch starts from the same deterministic,
versioned workflow prompt contract. The prompt labels the task fields, keeps
repository changes in the managed worktree, permits explicitly admitted
auxiliary roots when the task requires them, requires relevant verification,
and leaves the managed worktree ready for human review.

This change removes an authority-path difference without changing HRA's task
graph, scheduler, claims, leases, account selection, worktree custody, public
projection, or completion rules.

## Context

### Source assessment

This proposal comes from an independent architecture study of
[OpenAI Symphony at commit `8001b52e3062495a16e520e4ceaf8f9de868c4d0`](https://github.com/openai/symphony/tree/8001b52e3062495a16e520e4ceaf8f9de868c4d0).
HRA is not affiliated with or endorsed by OpenAI.

Symphony separates repository workflow policy from coordination and execution.
Its workflow store validates a candidate before replacing the last-known-good
policy, and its provider adapter keeps one session's advertised tools aligned
with the adapter that executes them. The relevant design is documented in
[`SPEC.md`](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md#L318-L531),
[`workflow_store.ex`](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/elixir/lib/symphony_elixir/workflow_store.ex#L122-L179),
and [`tracker.ex`](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/elixir/lib/symphony_elixir/tracker.ex#L43-L74).

The transferable principle is that one execution contract should own prompt
content that must not vary by adapter or authority path. HRA should apply that
principle to task dispatch now. HRA does not have live workflow-prompt reload,
so a content-addressed durable policy snapshot would add migration and protocol
surface without closing a present failure mode. The built application already
provides the activation boundary. A versioned module and renderer create a
clear evolution seam while exact tests make the prompt contract executable.

Symphony also reinforces useful control-loop laws: reconcile existing work
before new dispatch, refetch authority before an effect, keep retry state from
becoming a duplicate claim, and couple worker effects to current authority.
HRA already implements stronger durable versions of those laws with SQLite and
cloud receipts, boot and lease fences, explicit ambiguity, managed Git
worktrees, and inspect-before-effect recovery.

The following Symphony mechanisms do not transfer safely:

- In-memory claim, retry, and blocked state would regress HRA's restart-safe
  receipts and semantic deadlines.
- Tracker-owned task truth would flatten HRA's durable graph, review state,
  dependencies, ownership, and account policy.
- Arbitrary repository shell hooks and pass-through runtime commands would add
  an unsafe command-authority boundary.
- Generic reusable directories and automatic terminal cleanup would weaken
  HRA's run-bound worktree identity and ambiguity evidence.
- Automatic continuation and retry based on current tracker state would risk
  replaying an effect whose outcome is unknown.
- A mutable `WORKFLOW.md` would duplicate repository `AGENTS.md` instructions
  without a validated reload, signing, run-binding, or recovery contract.

No Symphony source or asset is copied by this work.

### Current HRA behavior

Cloud dispatch currently renders a task identity, description fallback, and
managed-worktree, verification, and review instructions in
`dispatch/runner.ts`. Local task execution renders only `Complete <key>:
<title>` and the optional description in
`state/local-run-execution-store.ts`. Both values become the same
`DispatchAssignment.initialPrompt` and enter the same session launcher.

The authority path therefore changes the agent's objective even when the task
facts are identical. Prompt construction also lives in persistence and
provider coordination modules instead of an owned contract seam. The local
launch candidate computes an `initialPrompt` that its consumer never reads,
then local durable admission computes the prompt again from
transaction-current task facts. Existing tests freeze the cloud string
incidentally but do not state a shared law.

The existing cloud instruction to work only in the managed worktree is also
too broad. HRA admits one selected shared folder as an additional runtime root
for every Codex turn. The common prompt must keep repository changes in the
managed worktree without denying access to an explicitly admitted auxiliary
root when the task requires it.

## Scope

### In scope

- Add one pure `task-workflow-prompt-v1.ts` module under desktop dispatch.
- Export a deterministic renderer over a closed typed task key, title, and
  description input.
- Route cloud and local task assignments through that renderer.
- Remove the unused prompt from the pre-admission local launch candidate.
  Render only from transaction-current facts during durable admission.
- Prove exact populated and empty-description output, determinism, limited
  whitespace normalization, field labeling, and local/cloud parity.
- Record the ownership rule in the dispatch agent guide.

### Non-goals

- A user-authored or repository-authored workflow template.
- Runtime policy reload or last-known-good storage.
- A new SQLite column, cloud protocol field, migration, or public projection.
- Changes to task authority, scheduling, claims, leases, retry, continuation,
  account reservations, workspace lifecycle, completion, or review.
- Persisting plaintext prompts or exposing prompts in cloud-visible evidence.
- A shared package. The prompt is product-owned and has no second
  product-neutral consumer.

## Constraints and decisions

### Built-in versioned prompt contract

The module and renderer name identify v1. A later behavior change must add or
deliberately replace a versioned prompt contract instead of silently growing
fragments in adapters. An exported version literal would be ceremonial because
this slice neither binds it to a run nor persists it. Because HRA does not
hot-reload this prompt, the installed application version remains the
activation unit. Durable content-addressed policy provenance belongs in a
separate proposal if HRA gains mutable runtime policy or must reproduce an
exact pre-turn policy after an upgrade.

### Closed typed input and deterministic output

The renderer accepts a closed TypeScript input containing `taskKey`, `title`,
and `description`. Cloud claims and local database rows have already crossed
strict foreign-value schemas, so parsing them again would create a new throw
inside claim handling or durable admission without adding trust. The input has
no repository paths, run IDs, account or provider identity, claims, leases,
sandbox values, credentials, or arbitrary prompt suffixes. The description is
trimmed because both existing paths already trim it. Validated task keys and
titles retain their content.

The v1 text labels task key, title, description, and working instructions. The
labels improve readability but are not a prompt-injection boundary because the
task text and instructions share one user message. Fences, sandbox admission,
managed-worktree custody, and repository instructions remain authoritative.
The intended runtime changes are that both paths receive the common labeled
prompt and that its workspace wording matches HRA's admitted-root model.

### Privacy and authority

The prompt contract stays local to the desktop runtime. It does not enter the
dispatch binding, durable public event outbox, cloud event stream, renderer
projection, or diagnostics. Existing fence and publication checks remain
authoritative. Prompt text cannot grant a capability or authorize an effect.

## Plan

1. Add the typed v1 renderer and focused contract tests.
2. Replace both private prompt builders with the shared renderer.
3. Remove the dead pre-admission local prompt field and render only inside the
   durable local admission transaction.
4. Add independent literal cloud and local integration assertions proving the
   same contract at both assignment seams.
5. Update the dispatch guide and public-tree manifest.
6. Run focused, desktop, KB, repository, and production-build verification.
7. Review the complete diff for authority, recovery, privacy, source, and
   adapter-parity regressions before delivery through a current-head pull
   request.

## Verification

- `bun test apps/desktop/runtime/test/task-workflow-prompt-v1.test.ts`
- `bun test apps/desktop/runtime/test/dispatch-runner.test.ts`
- `bun test apps/desktop/runtime/test/local-run-execution-store.test.ts`
- `bun run --cwd apps/desktop test`
- `bun run --cwd apps/desktop typecheck`
- `bun run --cwd apps/desktop lint`
- `bun run --cwd apps/desktop build`
- `bun run check:agent-guides`
- `bun run check:public-boundary`
- `bun run check:public-tree`
- Percolate this plan and the maintained durable-orchestration note, then run
  `bun run kb:refresh` and `bun run kb:check`.
- `bun run check`
- `bun run check:complete`
- Confirm the pull request's current-head `Required` check passes and all
  review threads are resolved before merge.

## Execution evidence

The implementation added the v1 renderer, routed cloud and local durable
admission through it, removed the unused pre-admission local prompt, and added
independent literal expectations at both assignment seams.

Focused verification passed:

- The prompt contract, dispatch runner, and local run execution tests passed
  with 74 tests and no failures.
- Desktop typecheck, lint, and production build passed.
- Agent-guide, public-boundary, and public-tree checks passed.
- Plan percolation produced one weak tag-only `notes/codex` candidate, which
  was reviewed and not promoted. Durable-note percolation produced no
  candidates. KB refresh and validation passed with 16 notes, 11 contextual
  links, and no typed relationships.

Repository-wide verification exposed only load-sensitive failures in untouched
test suites. One coordinated `bun run check` completed 3,054 of 3,056 runtime
tests and hit fixed wall-clock limits in two Harness authority cases. The exact
fast-check seed passed all 50 cases twice in isolation, and the other case
passed in 3.1 seconds against its 5-second limit. An exclusive
`bun run check:complete` cleared both of those cases, completed 3,048 of 3,056
runtime tests, then reproduced the existing full-suite interference in seven
bundled-Git cases and one session-sync case. Their untouched files passed
18 of 18 and 2 of 2 immediately in isolation. The separate root production
build passed for desktop, CLI, and web. Current-head required CI remains the
authoritative repository-wide delivery gate.

## Risks and recovery

The main behavior risk is an inaccurate workspace instruction. Both paths
enter `DispatchCoordinator`, which provisions or recovers the managed worktree
before the initial turn. Every Codex turn may also receive one explicitly
admitted auxiliary root. The prompt therefore limits repository changes to the
managed worktree and permits other admitted roots only when required. Local and
cloud integration evidence will keep that assumption visible.

Task text can contain instruction-like prose because it is the requested work,
and labels do not make it trusted. The prompt grants no capability. Runtime
sandbox admission, worktree custody, fences, and repository instructions
continue to enforce the actual boundary.

The change is schema-free and reversible. Recovery is to route both callers
back to their previous local helpers while retaining the comparative plan. No
durable data or external state requires migration or repair.

## Review findings

The independent proposal review rejected the first draft and found four
load-bearing corrections:

- Replace the inaccurate worktree-only instruction with the managed-repository
  and admitted-auxiliary-root distinction.
- Treat the text as a prompt contract, not an enforced execution policy.
- Keep the renderer typed and internal instead of reparsing already validated
  task facts.
- Remove the dead pre-admission local prompt and render at durable admission.

The revised plan also drops an unbound version literal, narrows the title to
task dispatch, and requires literal integration expectations that do not call
the renderer under test.

A bounded follow-up review approved the revised proposal with no remaining
blocker. Implementation began from this reviewed scope.

The implementation boundary review added the common invariant to the runtime
source guide because one caller lives under `state/`, required reviewed legacy
identifier evidence after source-line movement, and expanded KB verification
to percolate both changed authored notes before refreshing the catalog.

A fresh implementation review found no actionable correctness, recovery, or
test-coverage issue. A separate public-boundary and attribution review found
no remaining issue after the common guide ownership, local-state repository
scope, public-tree entries, and reviewed compatibility evidence were updated.
It also confirmed that the Symphony citations match the pinned official source
and that this change copies no upstream code or assets.

## Review gates

The proposal, implementation, and public boundary each received an independent
review. Their findings are resolved. Final delivery still requires a clean
current-head diff, required CI, no unresolved review thread, and a mergeable
pull request.
