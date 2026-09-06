# Devin provider and Astra defaults

## Status

Implementation complete on `codex/devin-provider-astra-20260905`, rebased onto
the model-routing integration in PR #112 and its provider-switch Work exclusion
repair in PR #114 (`1df685b`). Final delivery
remains pending the exact-tree aggregate gates below.

## Product decision

HRA will run the official local Devin CLI as an ACP v1 subprocess. The admitted
runtime is exactly Devin CLI `3000.6.14`, and every session starts with the exact
`devin acp --model gpt-6-astra` command before HRA validates ACP v1
initialization. A model-catalog probe is not part of admission because the
foreground login path must remain usable while the isolated profile is signed
out. HRA will not use Devin's cloud REST or MCP APIs for local sessions: those
APIs require separate `cog_` credential custody, create a different
remote-session lifecycle, and cannot currently guarantee an arbitrary model
selection.

The existing Codex `high` and `ultra` presets move from `gpt-5.6-sol` to
`gpt-6-astra`. Their reasoning efforts remain `max` and `ultra`, respectively.
Existing sessions retain their durable preset contract and reviewed runtime
history. New HRA sessions and explicit preset selections use the current Astra
mapping; queued and recovered work cannot reinterpret an established contract.

## Authority and privacy invariants

- Devin owns its credential file. HRA launches `devin auth login` in the exact
  profile-isolated XDG/HOME directories and reports only signed-in readiness.
- The ACP child inherits an allowlisted environment and receives no ambient
  `WINDSURF_API_KEY`, provider token, or user's global Devin configuration.
- Every child is fenced by profile id and process generation. A stale review,
  session, interaction, or reconnect is refused before another provider effect.
- Stdout is newline-delimited JSON-RPC only. Stderr is bounded diagnostics.
  Unknown ACP/vendor notifications are ignored or reduced explicitly; malformed
  protocol frames fail the connection closed.
- The neutral transcript stores bounded human/assistant text, lifecycle, tools,
  approvals, and usage projections, never raw ACP frames, credentials, or ACP
  thought chunks. ACP does not certify thought chunks as safe summaries, so
  HRA drops their content at the provider boundary.
- Account selection remains user-directed. HRA never switches or rotates Devin
  accounts to evade provider limits.

## Usage truth

ACP `usage_update` carries context usage (`used`, `size`) and may carry a
monetary cost. HRA records only those supplied usage and cost facts. The
effective runtime profile separately records the exact model HRA requested in
the launch argv. HRA does not reinterpret context usage as account quota.

The local Devin CLI has human-facing `/usage` and `/session-stats` commands, but
ACP v1 and `devin auth status` expose no documented machine-readable allowance,
remaining balance, reset time, or reset-credit mutation. HRA therefore reports
account allowance as unavailable/unknown and maps explicit provider refusals
such as exhausted credits or quota to bounded provider errors. It never submits
`/usage` as a hidden model turn and never invokes Codex reset-credit behavior for
a Devin account. A future cloud adapter may add administrative ACU observations
only under a separate explicit credential and authority design.

## Protocol surface

The first shipped matrix admits only:

- `initialize` with ACP protocol version 1;
- `session/new` and capability-gated `session/load`;
- `session/prompt`, `session/update`, and `session/cancel`;
- `session/request_permission` with bounded, durable HRA interaction authority;
- the standard file/terminal callbacks only when HRA advertises and implements
  them (the initial client advertises neither);
- standard message, tool, plan, command/config, and usage updates that have an
  explicit neutral reduction. HRA observes the kind of an ACP thought update
  but does not read or project its content.

ACP v1 has no in-turn steering method. HRA refuses a direct steer while a Devin
turn is active; the caller can explicitly queue the message for the next prompt
or stop the turn before sending another message. HRA never issues concurrent
prompt requests for one session. Interrupt sends `session/cancel` and waits for
the prompt result or child termination boundary.

## Delivery phases

### 1. Pinned provider core

- **Status:** Complete.
- **Scope:** pin/version admission, exact Astra launch argv, isolated process
  environment, strict auth status projection, foreground login custody, ACP
  framing/client, fact reduction, usage parsing, and deterministic
  fixtures/tests.
- **Acceptance:** malformed frames, version drift, and an ACP v1 initialization
  mismatch fail closed; every admitted session uses the exact Astra argv;
  signed-out status exposes no identity; every child is joined on shutdown.

### 2. Product integration

- **Status:** Complete.
- **Scope:** provider and preset unions, reviewed runtime profile, daemon runtime
  selection, interaction ownership, CLI composition and account commands,
  provider switching, cloud payloads, browser selectors, and append-only SQLite
  migrations for provider `CHECK` constraints.
- **Acceptance:** no binary fallthrough can route Devin to Codex or Claude; fresh
  and upgraded databases accept Devin while retaining older rows byte-for-byte;
  all provider directions preserve their exact runtime authority.

### 3. Usage and parallel-branch convergence

- **Status:** Implementation and main-first model-routing rebase complete.
- **Scope:** persist session usage supplied by ACP; keep unavailable quota
  explicit; reconcile with `codex/provider-usage-management-20260904` and
  `codex/model-routing-autonomy-integration-20260905` without editing either
  worktree or copying unfinished state.
- **Acceptance:** Devin never enters Codex reset paths; the provider-usage branch
  can add `devin_acp` as a source without migrating this branch's meaning; model
  routing recognizes the canonical Astra-backed Codex preset.

### 4. Verification and delivery

- **Status:** In progress.
- **Focused gates:** Devin protocol/client/runtime/adapter tests, provider and
  preset tests, migrations, provider switching, CLI, cloud payloads, and browser
  selectors.
- **Aggregate gates:** package inventory/pins, `bun run check`, exact-history CI,
  independent review, protected-main CI, deployment, and public readback.
- **Live gate:** in a disposable isolated profile, verify exact binary version,
  signed-out and signed-in status parsing, and exact
  `devin acp --model gpt-6-astra` startup with ACP v1
  initialization/capabilities, without sending `session/prompt`. This is a
  zero-token compatibility proof, not a claim that a real turn was exercised.

## Open evidence

The installed CLI passed a zero-token check in a disposable isolated profile:
exact version `3000.6.14`, requested model `gpt-6-astra`, signed-out auth status,
and ACP v1 initialization with `loadSession: true`. No session or prompt was
created. Signed-in status remains fixture-tested only.

The renewed review repaired auth-status cancellation races during runtime
admission and process creation; cancellation during a blocked transport write;
duplicate permission replies; credential and UNC-path redaction gaps; queued
turn handoff; false incompatibility notices for deliberately omitted ACP
metadata; and cumulative transcript omission accounting. Input framing now
pauses at bounded byte/frame capacity and resumes without dropping facts.
Focused evidence is 9 auth tests, 26 protocol/client tests, and 17 adapter
tests, all passing, with focused lint checks clean. Seven rebased historical
and v39 migration tests also pass. A final cloud review repaired sequential
optional-provider status probes blocking registry publication and unrelated
device commands. The 82-test cloud adapter suite passes with bounded background
observations, fair scheduling, expiry and authority invalidation, retry backoff,
and joined shutdown. CLI cleanup enters forced recovery when observation
process cleanup cannot be proved. The exact-tree aggregate gate remains the
final local delivery prerequisite.

Claude runtime admission now forwards the caller's cancellation to its version
probe, so background account discovery can join promptly during shutdown.
All 25 focused Claude adapter tests pass, including three regression-first
account/session-review/turn-review cancellation cases.

The complete application-source suite passes all 2,397 tests. Aggregate
validation also caught a stale installer digest in release notes and a stale
social-card expectation; both are corrected. The original intermittent
invalid-terminal startup test passed 31 isolated repetitions, while review
identified unnecessary recovery work before invalid configuration rejection.
The ordering is now corrected: four invalid-input cases reject before recovery,
while valid agent execution and resume retain the mandatory recovery gate.
Independent delta review also found invalid resume descriptors and receipts
could reach recovery. Shared numeric/range/nonterminal validation and the
existing bounded receipt parser now reject those inputs first. Eleven new
invalid-input regressions failed before the fix; all 49 scenario tests now
pass, including valid-run recovery refusal. Browser review corrected a stale
settings fixture
without changing the local-only Devin login contract. Zod's three exact JSON
Schema dialect literals are reviewed bundle metadata exceptions, with path and
query variants still rejected; no origin or CSP permission was added. All 18
focused browser tests pass. The converged tree awaits the final aggregate
replay and independent delta review.

After PR #114 convergence, all 16 focused Work/provider-switch and historical
migration checks pass. Independent review confirms both directions of the
Work/switch exclusion still use the canonical v39 authority. The recovery test
table has an explicit case type; repository type checking and its 17 focused
input-boundary cases pass.

The rebased service/storage suites pass all 452 tests and the web/backend
suites pass all 723. A host-scheduler receipt integration test exceeded Bun's
default five-second budget under load; a bounded latency probe reproduced its
timeout and the resulting next-test console-capture failure. That one test now
has a fifteen-second budget for its three real validation launches and 63
Git/toolchain subprocesses. The same probe and all 15 receipt tests pass; no
runtime deadline or security assertion changed, and the probe is not committed.

- A bounded paid turn is required before claiming real-provider turn, tool,
  approval, cancellation, and usage-update acceptance. Until then those paths
  are protocol/fixture verified only.
- Model routing and its Work/provider-switch safety repair merged first through
  PR #112 and PR #114; Devin is rebased onto that protected-main source. Other
  concurrent branches remain outside this
  worktree and must converge through protected main.
