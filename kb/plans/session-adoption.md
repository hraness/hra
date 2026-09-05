---
title: Personal-home session adoption
description: Delivery plan for automatically adopting Codex and Claude Code sessions from the owner's normal provider homes without weakening HRA session authority.
type: plan
status: in-progress
area: hra
tags:
  - codex
  - claude
  - sessions
  - authority
---

# Personal-home session adoption

## Outcome

After the owner explicitly enables personal-home discovery for an HRA account,
HRA discovers recently active Codex and Claude Code conversations from the
owner's normal provider homes. A discovered conversation becomes an HRA
session only after provider-specific admission succeeds. From that point onward
it has the ordinary session shape, commands, approval authority, autorespond
policy, queue, cloud projection, and grid presentation. There is no observed,
reduced-capability, or visibly adopted session tier.

## Adversarial decisions

The source proposal correctly found the isolated-home discovery boundary and
the imported-session provider bug. The following parts are rejected:

- No observed/attached tiers, adopted badge, quieter default, or approval
  downgrade. Those would contradict parity and duplicate controls that already
  work for any normal session row.
- No origin-specific account-change prerequisite or public detach command.
  Login, logout, provider replacement, and unprovable identity use one
  fail-closed recovery contract for HRA-created and adopted sessions.
- No fabricated transcript seed and no `foreign_turn` transport-gap event.
  Provider history is projected from the provider where supported; HRA's local
  event ledger begins when HRA gains custody.
- No claim of a provider-wide exclusive lease. HRA enforces one local binding,
  but Codex exposes no exclusive handoff and Claude cannot prevent a later
  external resume. Admission must state and test the narrower guarantees it
  actually has.
- No direct edits to provider state. Once admission succeeds, the pinned
  provider process may perform its ordinary writes in its own home.

Codex admission is attempted with the pinned private app-server and exact
`thread/resume`. The pinned protocol explicitly rejoins a running thread, so
that call is a policy-neutral identity, connection, and quiescence proof, not
an exclusivity proof. It must not change provider turn policy before the
durable adoption commit. Codex admission uses the user's accepted inactivity
inference: active rows and idle rows updated within 10 minutes remain pending;
idle rows older than 10 minutes are eligible only inside the 15-minute
discovery window. After commit, every HRA-owned turn applies a fresh reviewed
model, workspace permission profile, `on-request` approval routing, and
`auto_review` reviewer immediately before dispatch.

Claude's private peer surface does not carry tool-approval authority, so HRA
does not use its private key or socket. An active or uncertain Claude process
remains a candidate; after exact PID-domain, PID, and process-start evidence
proves the old process exited, HRA resumes the same session through the pinned
stream-JSON bridge and accepts it only when `system/init` proves the requested
session ID. The new process is held under durable process authority.

## Authority model

- Personal-home discovery is opt in, scoped to one provider and one existing
  HRA account, and defaults off.
- A provider home can be bound to at most one HRA account on one daemon.
- Runtime-home provenance and pending discovery state remain private SQLite
  authority. They never enter `SessionRecord`, Convex, or app session heads.
- Every admitted session operation resolves both the personal runtime port and
  the personal provider home from its private binding. Account login, logout,
  usage, plugins, and Desktop switching continue to use only isolated homes.
- The installation boundary injects personal provider homes. Production uses
  the current user's canonical homes; live acceptance uses only fixture-owned
  homes and therefore cannot read or mutate the operator's provider state.
- Account authority loss is controller-neutral. Login generation advance,
  explicit logout, externally observed sign-out, provider-account replacement,
  and unprovable identity first move every affected nonterminal session into
  durable `recovery_required` state. Undispatched work is cancelled, uncertain
  work remains ambiguous, scheduled work pauses, and every exact native or
  personal-home controller held by the prior authority is released. Restart
  resumes an incomplete release, and the account and session status surfaces
  keep it visible.
- Account-authority changes require no origin-specific session action. Internal
  release and revocation machinery closes the exact provider connection or
  process while preserving provider history and foreign processes.
- A completed personal-home Codex account revocation leaves the released
  account generation fenced. Adoption status reports `restartRequired`, and
  re-enable returns `RECOVERY_REQUIRED` until daemon restart creates a fresh
  runtime generation; ordinary account reads never bypass that fence.

## Delivery phases

### A. Durable policy and truthful import

Status: implemented; final validation in progress.

- Add an append-only schema migration for provider-scoped personal-home policy,
  pending candidates, and session runtime bindings.
- Require `provider`, provider-valid next-turn `preset`, and `fastEnabled` in
  `upsertProviderSession`; reject a provider collision.
- Add CLI commands for policy status/enable/disable and bounded discovery.
  Enabling performs an immediate discovery pass; there is no origin-specific
  public session command.

Acceptance: v35 upgrades restart-idempotently; the isolation boundary defaults
closed; repeated discovery and import are idempotent; public session schemas do
not change.

### B. Codex discovery and reviewed admission

Status: implemented; final validation in progress.

- Run a second pinned Codex runtime against the canonical personal Codex home.
- Read only a bounded recent provider page, admit only recently active threads,
  infer inactivity from the accepted quiet-time threshold, and use exact
  `thread/resume` as policy-neutral identity and quiescence admission.
- Persist a normal session only after exact thread ID, current connection,
  quiescent state, and project are proven. Apply the reviewed model, workspace
  permissions, approval policy, and approval reviewer on every owned turn.
  Existing pre-effect observation,
  mutation journaling, turn IDs, interaction authority, and ambiguity rules
  remain authoritative.

Acceptance: a quiet eligible external thread becomes a normal session; an
active, recently updated, or unknown thread remains pending without a public
  session row; a later poll can adopt it; every HRA session uses the same
  approval and autorespond integration path.

### C. Claude durable identity and resume takeover

Status: implemented; final validation in progress.

- Fix HRA-created Claude sessions to use and validate one real provider session ID.
- Discover sessions only through bounded scalar live-session registry metadata
  that names the exact pinned version. Do not invoke an unverified discovery
  command. Prove liveness with PID domain plus exact process start, never
  registry status or socket existence alone.
- When the source process is dead, launch the normal stream-JSON bridge with
  `--resume <session-id>` and accept custody only after `system/init` matches.

Acceptance: an HRA-created Claude session survives daemon restart; a dead external session is
resumed under the same ID; a live, unknown, copied, or mismatched candidate is
not admitted as a public session or granted runtime authority; future turns
expose the normal interaction and autorespond path.

### D. Projection, settings, and operations

Status: implemented; final validation in progress.

- Route daemon and cloud reads through the session's private runtime binding.
- Poll once at daemon admission and on a bounded interval with single-flight,
  backoff, and pathless diagnostics.
- Put the opt-in control and pending counts in settings without adding any
  adopted marker to session cards.
- Document discovery limits, nonexclusive handoff, liveness confidence,
  account-revocation restart fencing, and the pre-adoption local-event-history
  boundary.

Acceptance: the grid and public command surfaces cannot distinguish an admitted
session by capability; disabling discovery stops new claims but does not
degrade existing sessions; account loss applies the same visible fail-closed
recovery to both controller sources; daemon shutdown drains both runtime sets.

### E. Verification and delivery

Status: in progress.

- Run focused storage, parser, provider-runtime, service, cloud, and app tests.
- Run independent adversarial review over the converged diff.
- Run the repository final gate through the host scheduler on the exact tree,
  then follow the repository PR, merge, release, deployment, and production
  verification workflow that applies.
- Deploy the app-side optional aggregate-status reader before any daemon release
  that can upload the new optional registry field, because the previous app
  parser rejects unknown exact keys.

## Explicit residual boundary

Neither provider exposes a global lease against all later external resumes.
Codex adoption relies on the accepted 10-minute inactivity inference, and exact
resume cannot detect a still-open but quiet terminal. Claude proves that the
specific old process exited, but another process can race by resuming later.
HRA therefore promises one HRA binding plus exact resumed-channel authority,
not universal exclusion. The operator chooses one controller for subsequent
writes and must not resume the provider conversation elsewhere while HRA
controls it.

HRA does not answer an approval already delivered only to another controller
and does not fabricate that authority. Pre-adoption content can appear through
a real bounded provider projection, but HRA's local event export begins at
admission. The pinned Codex resume method also cannot add a thread-creation-only
dynamic tool to a thread that never had it. That limits model-originated
automation changes in arbitrary existing Codex threads, not the public HRA
session commands, scheduler, approval authority, or autorespond path.
