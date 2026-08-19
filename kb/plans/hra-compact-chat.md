---
type: plan
area: desktop-chat
status: blocked
title: Compact durable HRA chat
description: Make the desktop chat a dense touch-safe work surface with durable queueing and steering, image custody, verified full-access Codex execution, Markdown, active subagents, elapsed time, and stable pane identity.
tags:
  - chat
  - desktop
  - codex
  - accessibility
---

# Compact durable HRA chat

## Outcome

HRA's chat becomes a dense, durable control surface for long-running Codex
work. Thinking summaries and assistant responses render as safe Markdown.
Active subagents stay visible in a small pinned stack above the composer. The
composer supports images, a durable FIFO queue, explicit same-turn steering,
and one compact elapsed-time readout. Stable pane hues make a tiled session
legible without turning message surfaces into decoration.

HRA owns every production model, reasoning-effort, and service-tier choice.
It also owns one immutable Codex execution policy: approvals never pause a
turn and the Codex sandbox is danger-full-access. No renderer control can
weaken or override either policy.

The result must remain usable in a narrow multi-pane grid and on an iPad. It
uses small visual controls on fine pointers, at least 44-pixel action targets
on coarse pointers, explicit focus treatment, safe-area padding, forced-color
support, and no hover-only action.

## Current boundary

- Ordinary sends bypass an application queue. A second send while a turn is
  active is rejected even though the pinned Codex protocol already supports
  `turn/steer`.
- The Codex App Server has no queue API. HRA must own FIFO admission and crash
  recovery. `turn/steer` is an exact same-turn provider effect, not a queue.
- Chat starts currently hard-code on-request approvals and a workspace-write
  sandbox in several session paths. Steering inherits the active turn and
  cannot repair a weak start policy.
- The generated provider input supports `text`, `image`, and `localImage`.
  Its `mention` variant is specifically an app or plugin selection, not a
  generic filesystem attachment. HRA now uses native `localImage` for
  normalized raster images. There is no provider-owned opaque input for a
  generic file, so the live attachment boundary is deliberately image-only.
- Logical turn timestamps already support the requested elapsed-time display.
  Provider duration is a different diagnostic and must not be presented as
  logical turn time.
- Assistant Markdown already uses the product's sanitized renderer. Reasoning
  summary deltas are projected as plain text, and completion currently drops
  the full summary needed to reconcile a terminal value.
- Provider collaboration events are decoded and then collapsed into generic
  tool activity. A new private, content-free projection is required for active
  subagents.
- The attachment vault, custody ledger, and streamed encrypted backup are now
  implemented. The remaining work is to finish the provider-thread archive
  transition joins and current-head delivery gates.

## Scope

### In scope

- One application-owned durable message ledger for every ordinary send.
- FIFO queue projection, editing, removal, pause, resume, and exact same-turn
  steering of the head item.
- Image selection and clipboard paste, validated private storage, compact image
  previews, provider `localImage` delivery, retention, deletion, and backup.
- One verified full-access, never-ask production execution policy for ordinary
  chat, recursive actors, recovery, capability probes, and steering.
- Sanitized Markdown for assistant responses and bounded reasoning summaries.
- A bounded pinned projection of active provider and HRA subagents.
- Logical-turn elapsed time in `2h 1m 45s` form.
- Stable pane palette indices and golden-angle OKLCH identity tokens.
- Removal of tool-call rendering and all model, effort, tier, and routing
  controls from the chat surface.
- Dense keyboard, touch, narrow-width, reduced-motion, and forced-color
  behavior, backed by Direct scenarios.

### Non-goals

- Generic files, directories, device files, filesystem links, remote URLs, and
  executable attachment semantics. HRA does not overload the provider's
  app/plugin `mention` protocol or expose a private vault path as model text.
  Generic files remain out of scope until the pinned provider offers a
  structured, opaque input capability or HRA owns a separately reviewed safe
  extraction contract.
- Rendering raw reasoning or provider paths, thread IDs, prompts, subagent
  messages, models, effort, or account identity.
- Retrying an ambiguous provider start or steer.
- Fabricating image history during a cross-account text-only handoff.
- Treating pane hue as a status or accessibility signal.
- A provider approval UI or a user-facing execution-policy setting.
- Secure-erasure claims for SQLite WAL files or SSD blocks.

## Decisions

### Durable message authority

Every ordinary send first creates an idempotent message row. Each pane owns a
monotonic FIFO ordinal and a queue revision independent from the pane's live
stream revision. The complete bounded text and safe attachment metadata are
projected so an admitted message remains editable after renderer hydration.
Per-message, per-pane, and global bounds must keep the complete snapshot below
the existing transfer ceiling.

When the pane is idle, one SQLite transaction claims only the FIFO head and
binds its message ID, logical turn ID, immutable payload snapshot, and root
routing classification. A claimed message is immutable. Editing and removal
use the row revision and are valid only while the row is unclaimed.

Clean terminal success may schedule the next head. Stop first persists a queue
pause, then interrupts the provider. Restart, attention, quota uncertainty,
and any ambiguous effect retain a projected pause reason and require an
explicit Resume. Closing a pane atomically cancels every unclaimed or
prepared-without-effect message. Close is blocked while a start or steer has
an effect-started or ambiguous cut that has not been contained.

### Steering

HRA exposes one steer action, not a raw provider command plus a second queue
shortcut. It consumes only the exact FIFO head against the queue revision and
the exact accepted active logical and provider turn.

The steer journal advances through prepared, effect-started, acknowledged, or
ambiguous. A provider acknowledgement and the consumed tombstone commit
together. A terminal race before local effect admission leaves the row queued.
A lost response after effect start is permanently ambiguous, blocks the queue,
and is never retried or converted automatically into a new turn.

Enter enqueues, Shift+Enter inserts a newline, and IME composition never
submits. Command-Enter attempts an atomic enqueue-and-steer only when no older
queue head exists and the active-turn fence still matches. A visible Steer
action on the head row provides touch and keyboard parity.

### Attachments

The browser sends bounded sequential image chunks under an opaque upload ID.
It never sends a filesystem path or data URL. The browser and gateway reject
generic files before vault custody or provider admission. The gateway verifies
byte length, chunk order, and digests, then applies a closed raster MIME
allowlist, structure checks, decode, dimensions, frame count, and
decompression bounds before HRA commits a normalized immutable PNG
generation.

Temporary directories are mode 0700 and files are 0600. Writes use no-follow
creation, fsync, and same-filesystem atomic rename. A `ready` database row is
published only after the blob is durable. Startup reconciliation handles
temporary files without rows, staged rows without blobs, blobs without ready
rows, interrupted deletion, and retained leases. Garbage collection deletes
only objects proven unreferenced, unstaged, and unleased after a grace period.
The digest is verified on every read, provider use, and backup; a mismatch
triggers containment.

Danger-full-access makes the Codex child a trusted full-filesystem principal.
The vault is immutable through HRA's API and tamper-evident, but it is not an
OS isolation boundary against Codex. Its privacy guarantees apply to renderer
capabilities, unrelated messages and panes, logs, and ordinary application
interfaces, not to a fully trusted Codex process on the dedicated machine.

Draft leases expire. Queue admission atomically converts ready draft leases
into message references. Provider delivery holds a separate read lease through
terminal settlement and any ambiguity containment. A provider-thread lease
continues while a resumable rollout can retain the `localImage` path. History
pruning or queue cleanup cannot orphan that path. Pane archive and Delete All
Data contain readers before revoking references.

Preview reads prove the pane, draft or message, and attachment relationship.
One immutable lease backs the entire bounded transfer. The renderer receives
only validated static preview bytes, creates a `blob:` URL, and revokes it on
revision change, removal, or unmount. Product and Direct CSP add only `blob:`
to `img-src`; they never admit `file:` or custom vault schemes.

The authenticated backup format gains an attachment manifest and a consistent
SQLite, key, and vault generation. Restore validates every blob before a
journaled generation swap. A restored database can never reference absent or
unverified bytes. Provider account homes and rollouts remain outside this
backup, so restore does not promise exact continuation of image-bearing
provider context. Missing or unportable bindings enter an explicit context
reset instead of a text-only continuation.

Attachment-only input is valid. Image-only input uses the conservative
standard/Sol Max route. Before any image provider effect, route resolution
uses one exact-generation model catalog and filters for image input support.
Same-turn image steering is rejected unless the already active model has
verified image capability. HRA delivers normalized images as `localImage`.
Generic attachment kinds fail before a provider lease or effect. HRA never
turns a private vault path into model-visible text. Attachment-bearing history
is nonrepresentable in the provider's text-only handoff format, so
cross-account replacement takes the explicit safe context-reset path instead
of dropping attachments silently.

### Production execution policy

One runtime module owns the exact production policy:

- thread start and resume: `approvalPolicy: "never"`, sandbox
  `"danger-full-access"`;
- turn start: `approvalPolicy: "never"`, sandbox
  `{type: "dangerFullAccess"}`;
- approvals reviewer: `auto_review` when the pinned protocol exposes it;
- steer: no override, permitted only against an active turn carrying the
  verified policy receipt.

Every ordinary, recursive, recovery, and capability-probe path imports this
policy. Before mutation, HRA reads exact-generation configuration requirements
and fails closed if the account runtime cannot honor it. Returned thread
admission is parsed and must prove the policy when the provider response
supports that evidence. HRA never downgrades to workspace-write or shows an
approval dialog. An unexpected approval request remains an invariant failure.

### Thinking and responses

One memoized `MarkdownBlock` renders both assistant Markdown and the bounded
provider `reasoning.summary`. It skips HTML, disables model-supplied images and
controls, and admits only safe HTTP or HTTPS links through the existing native
navigation fence. It never renders raw `reasoning.content` or reasoning text.

Reasoning summary persistence keeps private item identity and summary index,
applies ordered deltas, and reconciles the full bounded summary from item
completion. A completion receipt stores its digest and overflow or gap state.
Terminal thinking is displayed only when that reconciliation proves the
retained summary; it is never inserted into provider handoff history.

### Active subagents

Provider collaboration identity remains gateway-private and is keyed by the
account, process generation, root provider thread and turn, raw child ID, and
stream position. The renderer receives only pane-scoped opaque ID, a bounded
display label, and `starting` or `running`. Pending initialization maps to
starting; terminal, interrupted, account-generation, and parent-turn terminal
events remove the child. Malformed or cross-pane transitions are discarded.

HRA persistent descendants remain a separately sourced projection with their
existing authority. Starting maps to starting; running and waiting map to
running. The combined view has a stable order, a fixed row cap, and an overflow
count. Provider rows are observational and never gain Harness controls.

### Duration and pane identity

The UI labels logical time `Turn elapsed`. Active time is
`max(0, now - startedAt)` and terminal time is exactly
`completedAt - startedAt`. One shared, visibility-aware one-second ticker
updates only active panes and stays outside live regions.

Pane creation allocates a monotonic bounded `paletteIndex` transactionally.
Migration orders existing panes by stable creation time and pane ID. Hue is
`(255 + index * 137.50776405) mod 360`; one shared OKLCH scale derives light
and dark ink, soft, strong, and on-strong tokens. Reordering panes never changes
identity. Status still uses text, glyph, outline weight, and system colors in
forced-color mode.

### Compact interaction surface

The pane body contains only a compact identity/status rail, the transcript,
and the pinned dock. Tool calls are omitted. The dock order is active agents,
queued messages, image previews, textarea, then a bottom action rail. The rail
uses a plus action on the left and elapsed time plus stop, retry, or submit on
the right. Rename moves into a tap-accessible overflow menu.

Fine-pointer controls remain visually small. Coarse pointers expand their hit
area to at least 44 pixels without increasing every row. The composer includes
bottom safe-area padding, matches DOM and focus order to visual order, and
keeps queue and agent stacks independently bounded. At 200% text and 26rem
width, no horizontal overflow is permitted.

## Current gate

The live `pane_archive` and `start_fresh` transitions are implemented and
production-default enabled. Migration v57 owns immutable targets, append-only
attempts, account-generation cuts, and frozen cut members. Store-owned HMAC
evidence binds pane, queue, provider thread, routing, message-ledger, attachment
binding, and lease preimages and terminal postimages.

One shared account admission gate closes every ordinary provider surface before
the first journal write. The router additionally requires an exact quiescent
generation: no active operation, turn, callback, server request, or login may
overlap archive admission. A foreign callback observed under quarantine taints
that generation until exact teardown. The expected one-shot `thread/archived`
notification is authorized by generation and thread digest, consumed without
being forwarded, and cannot reopen a wider callback exemption.

Direct success records the provider outcome, finalizes the exact terminal
component, deletes only the Store-verified all-committed authority, and releases
the Gate without an intervening await. Lost or ambiguous responses create one
durable cohort cut, fence the exact source generation, enumerate and seal every
source owner, settle each member atomically, reconcile against a positioned
successor catalog, and run any not-applied successor attempts as an all-target
wave. Reconciliation buffers the complete cohort before replacing or releasing
any authority. Source enumeration treats a settled route as historical
provenance unless the pane still owns unresolved Store authority. Explicit
archive targets and exact cleanup initiators remain contained, while unrelated
settled panes keep their provider thread and attachment binding for an exact
successor-generation resume.

Startup performs Store terminal verification, exact Vault cleanup authorization
and reconciliation, an atomic Store terminal sweep, and AccountService replay
from the same returned recovery inventory before account, Session, Harness, or
provider initialization. The sweep deletes only verified all-committed
`pane_archive` and `start_fresh` components. Mixed open/committed components and
every zero-target `account_removal` cut remain durable and quarantined. The v57
account-removal coordinator is still deliberately dormant and must not be
enabled without its separate Vault inverse-admission join.

Hostile review approved the enabled transition with no P0/P1 finding. Focused
runtime, startup, Session, Store, Vault, journal, portable projection, Direct,
typecheck, lint, and diff gates are green. Repository delivery remains blocked
by the inherited published-release source test: the current development branch
is not the clean one-commit publication transition required by the v0.1.10
release-provenance gate. No merge or release is claimed until the repository's
release protocol returns to an admissible source state and `check:complete`
passes there.

## Dependency-ordered work

1. Freeze contracts, queue and attachment states, execution policy, provider
   evidence, snapshot bounds, and the additive migration sequence through the
   provider-context and archive-intent fences.
2. Implement the centralized full-access policy and exact-generation
   requirements proof across every session path.
3. Implement the durable message ledger, atomic enqueue receipt, FIFO claim,
   queue pause/resume, close semantics, and restart recovery.
4. Wire exact same-turn steer through the existing SessionService operation
   with its no-replay journal.
5. Implement the private image vault, upload and preview protocols, model
   modality resolution, provider `localImage` codec, lifecycle leases,
   deletion journal, and backup/restore generation.
6. Reconcile reasoning summaries and project bounded provider and Harness
   active subagents.
7. Add palette allocation and logical-duration selectors.
8. Replace the chat pane with the compact Markdown transcript and dock; remove
   model, route, tool, and configuration chrome.
9. Replace obsolete Direct worlds and browser assertions with deterministic
   queue, steer, attachment, Markdown, subagent, duration, color, touch, and
   compact-containment scenarios.
10. Run hostile crash-cut, privacy, accessibility, and production-boundary
    reviews, then the repository's current-head complete and Direct gates.

## Verification

- Migration property tests cover constraints, deterministic upgrade,
  FIFO/ordinal uniqueness, queue revisions, effect cuts, leases, privacy
  deletion, and reopen recovery.
- Queue model tests cover enqueue idempotency, bounds, head-only claim,
  edit/remove CAS, pause reasons, close cancellation, and no overtaking.
- Steer tests cover exact active-turn fencing, head-only consumption, terminal
  races, acknowledged tombstones, lost-response ambiguity, and no conversion
  to an ordinary turn.
- Attachment tests cover chunk replay/conflict, byte truth, decoding and
  decompression limits, no-follow custody, crash recovery, lease/ref/GC laws,
  preview authorization, backup, restore, and whole-data deletion.
- Provider tests prove one exact-generation profile, tier, modality, and
  production-policy resolution before mutation, with no silent fallback.
- Codec and projection tests prove rich input ordering and that paths, provider
  IDs, prompts, child messages, raw reasoning, and tool payloads never cross
  the renderer boundary.
- Renderer tests cover Markdown sanitization, terminal reasoning receipts,
  duration formatting, keyboard and IME behavior, touch actions, object-URL
  cleanup, bounded stacks, and accessible state text.
- Direct covers active and terminal Markdown, zero rendered tools, native and
  Harness agents, queue/edit/remove/steer, picker and paste images, stable pane
  hues, 26rem and 200% containment, coarse pointer targets, safe area, forced
  colors, and production exclusion.
- Final delivery runs focused suites during edits, affected checks per lane,
  agent-guide and KB checks after documentation changes, then current-head
  `check:complete`, desktop Direct, web Direct when its shared contract changes,
  Required CI, preview verification, conflict/review audit, merge, and exact
  protected-main verification.

## Recovery

Schema upgrade is additive and restart-safe. Untouched queued rows remain
eligible; admitted or effect-started rows are never replayed. A failed or
ambiguous start or steer pauses the pane until explicit resolution. Attachment
staging and deletion are journaled and idempotent. Restore never publishes a
partial DB/key/vault generation. Renderer reconnect reconstructs the complete
bounded queue and active-state projection from one authoritative snapshot.

If a provider generation cannot prove full access, image modality, or an exact
active turn for steer, HRA performs no provider effect and retains the local
message. Removing the feature does not require weakening these receipts: the
renderer can stop exposing enqueue and upload while the durable ledger remains
inspectable and recoverable.

## Execution evidence

- 2026-08-18: The live attachment boundary is image-only. Browser, gateway,
  store, and provider tests prove generic kinds fail before custody or provider
  effects, while normalized images use ordered `localImage` input.
- 2026-08-18: Attachment upload, preview lifecycle, queue projection,
  capability evidence, provider leases, account-loss containment, and explicit
  fresh-context recovery passed their focused desktop suites.
- 2026-08-18: Streamed backup and Restore C passed 55 backup tests, 19
  maintenance tests, and 9 local-data-removal tests. These cover authenticated
  framing, bounded memory evidence, journal-before-stage custody, the
  SQLite/key/vault generation swap, rollback, crash recovery, and privacy
  inventory.
- 2026-08-18: The safe provider-archive interim passed 213 focused store,
  vault, and service tests plus desktop typecheck and focused lint. Pending
  archive intents fence ordinary mutation and bootstrap recovery; privacy and
  account-contained cleanup are atomic; provider-bound close fails before any
  external effect.
- 2026-08-18: The portable transition passed 61 projection and backup tests
  with 542 assertions. It removes every five-state, two-purpose archive intent
  only from the private copy, authenticates every removed field and count,
  fences affected panes, preserves source DB/vault bytes, and restores zero
  provider archive intents.
- 2026-08-18: The post-approval safe live cut passed 255 focused store,
  service, account, session, and integration tests plus a compiled-gateway
  regression, typecheck, lint, and diff checks. Exact-generation cleanup
  preserves account B and successor N+1 while deliberately containing every
  pane context last owned by fenced generation N. Provider-bound archive
  effects remain disabled pending the crash-persistent state machine above.
- 2026-08-19: The normalized v57 journal, shared admission gate, exact router
  recovery lane, AccountService authority, Session scans, ChatPane settlement,
  attachment and repair fences, portable projection, and ChatService
  coordinator passed independent hostile review. The coordinator covers every
  durable restart phase, untargeted sibling containment, atomic successor
  waves, postcommit pane handoff, and the 64-target recovery bound. Direct
  Remove, direct Start fresh, and grouped startup recovery prove the
  production-default enabled path; an explicit override retains the rollback
  gate for tests.
- 2026-08-19: Startup now verifies Store-owned terminal authority, authorizes
  and reconciles Vault cleanup, atomically deletes only exact all-committed pane
  components, and installs AccountService quarantine from the same returned
  recovery inventory before account or Harness initialization. A real
  file-backed close/reopen test proves exact connected-component deletion,
  mixed-component retention, zero-target removal-cut preservation, idempotent
  second startup, and zero provider construction or RPC before replay.
- 2026-08-19: The final provider-quiescence cut counts every accepted callback,
  turn, server request, login, and operation; retains generation taint until
  teardown; consumes only the exact expected archive notification; and performs
  synchronous outcome, finalization, release proof, journal cleanup, and Gate
  release after the final provider await. Independent hostile re-audit found no
  P0/P1. Router passed 52 tests, AccountService 58, the admission gate 16, Chat
  v57 30, startup 2, and Session archive 8.
- 2026-08-19: A final cross-surface audit found and closed an overbroad sibling
  cleanup rule. Generic generation cleanup and v57 source enumeration now
  exclude unrelated settled panes unless unresolved route, message-effect, or
  turn-lease authority remains. Exact targets and cleanup initiators stay in
  scope. A retained-attachment regression proves the sibling pane and binding
  remain byte-identical through lost-response containment and resume the same
  provider thread under generation N+1. Independent re-audit approved the cut;
  ChatService and ChatPaneStore passed 236 tests with 7,659 assertions.
- 2026-08-19: Desktop Direct passed every current scenario, including compact
  widths, 200% text, coarse pointers, same-origin blob previews, hidden native
  inputs, and the 64-pane streaming composition. The full ChatService suite
  passed 170 tests with 1,134 assertions. Desktop typecheck, full lint, and diff
  checks are green.
- 2026-08-19: The repository source check passed public policy, generated
  compatibility/public-tree manifests, root tests, every workspace typecheck,
  every workspace lint, and 2,932 of 2,933 tests on the final frozen tree. All
  nine actionable fixture/contract failures from the first run were repaired;
  their combined focused rerun passed 87 tests with 3,467 assertions. The sole
  remaining failure is the pre-existing v0.1.10 release-provenance requirement
  described in Current gate. It rejects both dirty linked worktrees and
  post-publication commits by design.

## Review findings

- The proposed generic-file text envelope would disclose a private local path
  to the model and has no matching structured provider capability. It was
  removed. Image-only admission is the current product contract.
- Restored provider context cannot be resumed safely without the provider home
  and rollout state. Portable copies therefore preserve transcript and image
  bytes while removing resumable provider authority and requiring an explicit
  fresh message.
- A provider-thread archive outcome must be journaled before its effect and
  reconciled after an ambiguous response. Pending archive intents fence normal
  pane and queue mutation so uncertain provider context cannot be reused.
- Holding an account only around the provider stop is insufficient. Admission
  must remain closed through sibling containment, archive reconciliation, and
  the local commit; the hold must also be reconstructed before any startup
  account or Harness request. A crash between sibling detachment and ledger or
  lease settlement requires durable inventory, not an in-memory callback.
