---
title: Oh memory and session civilization
description: Active delivery plan for stable two-authority Oh memory, attributed same-project session coordination, provider-native HRA tools for Codex and Claude Code, encrypted canonical-memory sync, and supervisory visibility.
type: plan
status: in-progress
area: hra
tags:
  - bun
  - codex
  - claude
  - convex
  - memory
  - coordination
relations:
  related-to: [ plans/hra-v1, plans/hra-v2, notes/agent-first-coordination ]
---

# Oh memory and session civilization

## Outcome

Every newly bound Codex or Claude Code session receives one static HRA preamble and a closed provider-native tool surface. Such a session can inspect bounded provider-neutral state for another session in the same project, send an attributable queued message, or steer a supported active turn. It can remember into its own expiring Oh working authority, query that working authority together with a durable project canonical authority, explain results, and explicitly share nominated memory through a destination-owned compare-and-swap adoption. The initial Devin ACP adapter remains text-only and does not bind the preamble or HRA host-tool server in this local release; Devin can receive bounded send or queued peer input, but cannot originate these model tool calls or accept an in-turn steer. Its session memory remains available through the owner CLI.

Oh remains agent agnostic. HRA consumes a stable `@hraness/oh/memory` contract, owns project and session bindings, implements Oh's operation-sync transport over client-encrypted hosted storage, and never puts an HRA identity provider or HRA-specific transport into Oh.

## Constraints

- Preserve HRA's operating-system-user local custody model. Provider callbacks and a narrow Claude bridge provide application attribution, not hostile same-user process isolation. Peer credentials, PID ancestry, environment markers, and a second readable bearer do not create that boundary.
- Use append-only, transactional, restart-safe HRA migrations. Do not rewrite a released schema.
- Derive the calling session from the provider callback or daemon-minted bridge binding. Model input never selects its actor, account, project, store, locator, rules, clock, operation ID, sync credential, or purge authority.
- Peer coordination is enabled by default within the actor's exact current project. Keep a per-session `off | inspect | coordinate` revocation policy. Cross-project and cross-machine session addressing, autonomous session creation, approval resolution, stop, switch, archive, rename, and attachment transfer are out of scope.
- Treat peer messages and memory text as untrusted user data, never system text or approval. The target session's existing approval and autorespond policy remains the only approval authority.
- Persist mutating peer evidence before provider dispatch. Store bounded identifiers, policy decisions, causal links, and content digests, not message or transcript bodies. Bounded inspect reads remain non-mutating.
- Retain complete peer replay and causal detail for at least seven days, then prune only closed terminal subgraphs on a later new admission. Pin active actor and target turns, unsettled effects, unresolved evidence, and every recursively required parent and root. Preserve queue `peer_session` attribution after an eligible terminal or resolved action link is detached.
- Use a peer-specific causal limit of eight. Do not reuse Work DAG depth or manufacture implicit Work membership. Conservatively union all peer origins attached to the actor turn when checking cycles.
- Keep per-session working memory's existing 30-day lifecycle and fork semantics. Add one physical canonical database per project with no TTL. Serialize all memory operations for one project in one coordinator, with canonical adoption and sync under that same owner, while keeping physical project authorities separate.
- Sync canonical project authorities only. Client-side encryption, operation verification, fast-forward-only settlement, explicit divergence, bounded quotas, retention, erasure, and recovery evidence are mandatory. No Turso credential path is added to HRA; Oh's existing alternate transport is sufficient independence evidence.
- Static preamble bytes and the host-tool manifest are versioned and digest-bound to each bound Codex or Claude Code session. They contain no live lists, clocks, heads, paths, credentials, or dynamic state. Bound resume and a switch into Codex or Claude Code retain or admit one exact version. A switch into Devin records no HRA preamble or host-tool binding until exact ACP transport and policy-context behavior is proven.
- Workers own focused validation. The integration owner runs `bun run check` on each converged repository tree through the required HRA host scheduler, then follows each repository's documented review, release, deployment, and production-readback flow.

## Decisions from adversarial review

1. Codex 0.153.2 exposes stable `developerInstructions` on thread start and resume. Claude Code 2.1.260 must be captured and proved to support `--append-system-prompt` and `--mcp-config` before those flags enter its reviewed argv. HRA will not modify project `AGENTS.md`, install profile-global instructions, or impersonate the owner with an opening user turn.
2. The global daemon bearer remains an owner-CLI authority under the documented same-user trust model. This work does not claim to fence arbitrary code executing as the owner. True hostile-agent isolation needs a separate OS-principal or privileged-broker design.
3. Generic peer messages use HRA's existing prepared send, queue, and steer effect patterns, but not the Work protocol. Work membership and its depth field mean something different.
4. Raw Oh SDK CRUD is not the model boundary. Oh first graduates its locator-free two-authority agent surface and adds separate host-only canonical rollover and nomination admission.
5. Sharing is explicit. `remember` writes working memory; `share` nominates and adopts under HRA's destination policy. HRA does not automatically publish every model thought.
6. Hosted sync and app visibility follow the validated local authority model in a second HRA release rather than enlarging the first release's recovery surface.
7. The local release exposes the closed provider-native HRA host-tool manifest to bound Codex and Claude Code sessions, plus an owner-facing `hra memory` command group for every supported session provider, including Devin. Both call the same `HraMemoryPort` coordinator and share the same bounded value schemas; neither exposes an Oh locator, arbitrary CRUD, caller-chosen rules, purge authority, or head acceptance.
8. One HRA coordinator serializes all memory work per project, including per-session working writes and composite reads. This deliberately trades same-project memory concurrency for one canonical-head, recovery, and project-change boundary. Different projects remain independent.
9. HRA never synthesizes or blindly retries a canonical replacement after a share conflict. Oh offers a host-only replacement primitive bound to an exact prior record digest, but HRA returns conflict evidence and keeps that primitive unreachable until the owner explicitly authorizes durable canonical overwrite semantics.
10. Exact mutation replay is finite, while active-page attestation evidence has reference-bounded lifetime. Terminal submissions remain for at least 30 days, are pruned only before a later admission, and are capped at 10,000 rows per project. Unsettled recovery evidence is never pruned. Compact evidence remains independently for every currently referenced working or canonical page and is collected after replacement or proven working-authority purge. Tool receipts expose `idempotencyRetainedUntil` rather than implying permanent same-key replay.
11. Local fork admission uses Oh's stable 32 MiB memory-lane limit and 8,192-record limit. The combined SQLite database and WAL ceiling is 512 MiB. HRA configures a transactional page limit so a capacity failure rolls back before an operation ID can become durable.
12. Same-profile provider switches preserve the account-bound working authority. Cross-account switches fail before provider effects once memory exists; because sessions acquire memory at start, this is a deliberate compatibility restriction pending explicit authorization for cross-account memory transfer.
13. A canonical divergence freeze is sticky and visible through `hra memory status`. The local release has no thaw, canonical rollover, project-memory erasure, or project-removal path; those operations require an exact separately authorized custody design.
14. Peer-action replay is finite without making recovery evidence disposable. HRA admits at most 120 new actions per project per rolling hour, keeps full action and causal rows for at least seven days, and caps the project at 25,000 rows. The seven-day rate envelope is 20,160 rows, leaving 4,840 rows of protected headroom. Admission-triggered cleanup removes only old terminal closed subgraphs; active-turn, unsettled, unresolved-evidence, parent, and root pins win over cleanup, and capacity then fails closed. Eligible queue rows retain their durable `peer_session` actor after the detailed action reference is detached.

## Phase map

| Phase | Outcome | Depends on | Write scope | Parallel with |
| --- | --- | --- | --- | --- |
| 1 | Stable Oh memory authority and public v0.4.0 | none | Oh memory source, spec, public surface, generated distribution, release metadata | HRA phase 2 design only |
| 2 | Shared HRA tool manifest and static provider preamble | none | HRA domain host-tool contract, Codex protocol/client, provider runtime ports, preamble evidence | Phase 3 |
| 3 | Durable peer and project-memory control state | none | HRA append-only migrations, peer policy/action/lineage/queue provenance, memory attestations and project bindings | Phase 2 |
| 4 | Local two-authority memory in model tools | 1, 2, 3 | HRA Oh adapters/coordinator, lifecycle seam, daemon composition | none |
| 5 | Attributed peer inspect, queue, and steer | 2, 3 | HRA peer service, transcript actor/projection, queue/send/steer integration | Phase 4 after shared contracts settle |
| 6 | Claude provider parity | 2, 4, 5 | exact-pin fixture, Claude argv/config, narrow stdio MCP bridge and daemon agent envelope | none |
| 7 | Local release validation and delivery | 1 through 6 | convergence files, docs, package/release metadata | none |
| 8 | Encrypted Oh operation sync | 7 | cloud transport, Convex schema/functions/lifecycle maps, local sync journal and coordinator | app read-model design |
| 9 | Hosted supervisory app visibility | 8 | encrypted projection, app models/screens, docs | none |
| 10 | Hosted release, deployment, and production proof | 8, 9 | convergence files and delivery metadata | none |

## Phase 1: Graduate Oh memory

- **Status:** In progress
- **Depends on:** none
- **Objective:** Publish a stable, HRA-independent two-authority memory API as `@hraness/oh/memory` v0.4.0.
- **Scope:** Keep `remember`, named/paginated `query`, `explain`, and `nominate` on an agent-only object. Add a separate host object with serialized `advanceCanonical` and `adoptNomination`, including an optional bounded host-only exact-prior-record replacement claim. Retain the experimental subpath as a compatibility alias.
- **Out of scope:** HRA identity, HRA transport, automatic conflict merging, model-chosen canonical writes, and new persisted Oh wire bytes.
- **Approach:** Canonical advance proves same-head idempotence or exact reachable descent before swapping the captured lane. Adoption strictly reparses and re-exports a nomination from the bound working store, compares the exact canonical snapshot, and inserts all missing closure records in one CAS. A different digest conflicts by default. The host may replace only when every supplied claim names the exact canonical prior record digest and nominated key; the operation identity binds the prior head and exact changes. HRA v1 supplies no replacement claims. Old explanations survive rollover; continuations remain bound to exact source heads.
- **Acceptance criteria:** Stable and experimental imports resolve to the same reviewed implementation; the agent object has no host/store/sync/purge handle; rollover rejects rollback/unreachable heads; default adoption is dependency-complete, idempotent, all-or-nothing on conflicts, and resistant to a forged self-digested nomination; optional replacement validates every claim and cannot alias a different parent or change set under one operation ID.
- **Validation:** `bun test ./src/memory.test.ts`; Node portable type/runtime tests; package smoke; `bun run check`; reviewed PR; annotated immutable v0.4.0 release; npm and GitHub artifact/provenance readback.

## Phase 2: Add the static HRA capability contract

- **Status:** In progress
- **Depends on:** none
- **Objective:** Give each session an exact static explanation of HRA and one provider-neutral closed host-tool manifest.
- **Scope:** A versioned preamble and manifest digest; generic Codex host-tool parsing/dispatch while preserving automation scoping; Codex developer instructions on start/resume; provider-port fields and durable start/resume evidence.
- **Out of scope:** Live data in instructions, project file mutation, model-facing shell commands, and Claude's transport implementation.
- **Approach:** Generate both Codex dynamic tools and Claude MCP tool declarations from one domain manifest. Persist the admitted preamble/manifest version and digest per session. The pinned Codex `thread/resume` surface cannot add dynamic tools to a legacy thread, so pre-feature sessions remain explicitly unbound instead of receiving a misleading preamble; a newly started thread or an idle provider switch admits the closed manifest and exact preamble together. Bound sessions resume with their exact admitted bytes.
- **Acceptance criteria:** Exact schemas omit actor/capability/store fields; unknown tools fail closed; callbacks bind thread, turn, profile generation, and request digest; bound resume preserves exact preamble bytes; unbound legacy resume injects neither a capability claim nor a partial facade; automation behavior remains byte-compatible.
- **Validation:** Focused domain, Codex protocol/client, runtime-adapter, state-store, and service tests.

## Phase 3: Add durable peer and memory control state

- **Status:** In progress
- **Depends on:** none
- **Objective:** Establish restart-safe policy, causal provenance, prepared effects, and project-memory bindings before model mutations exist.
- **Scope:** Append-only local schema migration; effective peer policy; peer actions, parents, visited sessions, turn origins, hourly budgets, queue provenance; memory submission attestations; project canonical binding and sync status metadata.
- **Out of scope:** Semantic payloads in control SQLite, provider dispatch, and hosted bytes.
- **Approach:** Admit an idempotent peer action, apply the aggregate project and actor budgets, and prune eligible expired history in one transaction. Attach every accepted peer effect to the resulting or active target turn. Query all origins for a calling turn and union their visited sessions. Retain current-turn and recovery authority recursively through every parent and root; detach only terminal or resolved queue action references while preserving the queue actor. Keep project/session/store paths derived and outside rows.
- **Acceptance criteria:** Exact N/N+1 project-rate, actor-rate, and fan-out boundaries; replay spends no second budget; at least seven days of exact replay survives; only closed terminal subgraphs expire; active cycles and unsettled recovery remain reconstructable across restart; protected capacity fails closed at 25,000 rows; queue attribution survives both restart and action compaction; self/cycle/hop/stale-policy admission fails before effect; no table contains message, transcript, memory-page, credential, or path bytes.
- **Validation:** Focused state-store migration, downgrade, concurrency, policy, peer-ledger, queue, and custody tests.

## Phase 4: Make local Oh memory usable

- **Status:** In progress
- **Depends on:** phases 1, 2, and 3
- **Objective:** Give every project-bound session stable Oh working plus canonical memory, with model-facing HRA host tools on bound Codex and Claude Code sessions and the owner CLI on every provider.
- **Scope:** Exact Oh v0.4.0 pin; one per-project canonical SQLite authority; current per-session working authority; memory-page codec; small fixed list/get/search projection programs; Codex and Claude Code provider-native tools plus owner-CLI `remember`, `query`, `explain`, status, and explicit `share`; project serialization; finite replay evidence; exact crash recovery; capacity guards; and conflict receipts.
- **Out of scope:** Raw Oh CLI/SDK access, arbitrary JSON records, caller-supplied provenance, generic rules, direct canonical put, automatic share, replacement after conflict, semantic embeddings, and working-memory upload.
- **Approach:** HRA constructs bounded memory-page editions and host attestations from submitted text. `share` prepares a nomination from the agent surface, then invokes the retained host adoption authority against the exact reviewed project head. Every memory operation passes through one project tail. Session project changes rebuild the composite against the new canonical lane without moving working bytes across projects. Queries expose lane, proof, conflict, and explicit local-ledger verification state. Startup reconciles exact physical descendants without replaying an uncertain effect and freezes canonical-dependent work on unexplained divergence.
- **Acceptance criteria:** Remembered pages are immediately queryable in working memory; shared pages are visible to another session in the same project; a different project cannot read or nominate them; conflicts surface current heads and record digests without blind retry; exact terminal replay lasts through its advertised retention boundary; unsettled effects recover from exact Oh history without speculative dispatch; capacity failure leaves the prior head and operation-ID namespace unchanged; per-session archive/expiry still purges only working memory; canonical memory survives session deletion and daemon restart.
- **Validation:** Focused Oh adapter, lifecycle, memory coordinator, host-tool, provider switch, project switch, restart, conflict, retention, recovery, capacity, and negative authority tests.

## Phase 5: Add peer-session coordination

- **Status:** In progress
- **Depends on:** phases 2 and 3
- **Objective:** Permit bounded, attributable same-project inspection and messaging without granting session administration or approval authority.
- **Scope:** `sessions_list`, `session_inspect`, and `session_message` with `queue | steer`; exact session IDs and target revisions; provider-neutral transcript pages; `peer_session` event actor; action log and cloud-safe projections.
- **Out of scope:** Cross-project access, semantic summaries, raw provider streams, hidden reasoning when disabled, and every administrative or interaction-resolution command.
- **Approach:** Resolve the actor from callback authority. Wrap delivered text with fixed host-authored peer provenance and an explicit untrusted-data warning. Reuse the target's prepared mutation and ambiguity logic, but bind peer actor/evidence and do not reset autorespond counters. Inspect returns bounded existing transcript records and classifier state and does not create a ledger row.
- **Acceptance criteria:** Self, cycle, ninth hop, stale revision, state mismatch, scope mismatch, policy off, project-rate, actor-rate, and fan-out cases all refuse with distinct stable codes; queued origin survives delayed dispatch; multiple steer origins are unioned; active origins and their causal ancestors survive retention cleanup; compacted terminal queues remain attributable to `peer_session`; target approvals behave exactly as for any other untrusted turn; no peer message renders as owner-authored.
- **Validation:** Focused domain, transcript, state, service, queue, projection, CLI, and app-model tests including crash/ambiguous effect recovery.

## Phase 6: Add Claude provider parity

- **Status:** In progress
- **Depends on:** phases 2, 4, and 5
- **Objective:** Expose the exact same HRA tools and static preamble to pinned Claude sessions with a session-bound callback authority.
- **Scope:** Capture exact Claude 2.1.260 help/protocol evidence; append-system-prompt argv; per-session MCP config; a bounded stdio JSON-RPC bridge; an agent-only daemon envelope whose ephemeral file capability maps to one session and only the host-tool union; lifecycle revocation.
- **Out of scope:** General local commands, operator daemon authority, MCP OAuth, profile-global configuration mutation, and claims of hostile same-user isolation.
- **Approach:** The daemon creates the local session placeholder before provider start, mints one user-only ephemeral bridge binding, and passes a derived config file rather than a secret argv/environment value. The bridge reads its standard derived binding, implements only initialize, tools/list, tools/call, ping, and required notifications, and cannot express a general HRA command. Binding activates only after provider-thread commit and is revoked on process exit, provider switch, or daemon generation change.
- **Acceptance criteria:** Claude advertises the same manifest digest as Codex; wrong/stale/revoked bindings and malformed/oversized frames fail closed; model input cannot name its actor; bridge output contains no locator or capability; provider switch does not retain the old authority.
- **Validation:** Exact-pin runtime tests, MCP bridge protocol tests, daemon transport tests, Claude adapter lifecycle tests, and one bounded authenticated live tool call when credentials are available.

## Phase 7: Validate and deliver the local release

- **Status:** Not started
- **Depends on:** phases 1 through 6
- **Objective:** Ship the usable local memory and peer capability as one coherent HRA release.
- **Scope:** Documentation, package pin/policy, migration notes, public claims, independent impact review, final gate, PR, merge, release, install proof.
- **Out of scope:** Hosted operation bytes and browser rendering.
- **Approach:** Update facts-memory documentation to distinguish working and canonical authorities, document the same-user residual honestly, and explain why peer traffic is not Work. Preserve historical plan evidence. Run the change-impact skill before delivery and repair every material finding.
- **Acceptance criteria:** Fresh install and upgrade both work; existing session, queue, facts-memory, automation, Work, projection, and approval tests remain green; public docs do not claim socket isolation or Claude parity beyond proved evidence.
- **Validation:** Repository focused gate plus exact-tree `bun run check` through `hra-host-run`; PR checks; merged-main install smoke; release and artifact readback.

## Phase 8: Add encrypted Oh operation sync

- **Status:** Not started
- **Depends on:** phase 7
- **Objective:** Implement one HRA-hosted `OhOperationSyncTransportV1` for canonical project memory without exposing plaintext to Convex.
- **Scope:** Random remote space identity and encrypted project mapping; purpose-separated opaque tokens; encrypted operation bundles; server sequence/CAS; local outbox and uncertain-effect reconciliation; sync before canonical mutation and after commit; dedicated quotas, retention, erasure, revocation, and maintenance coverage.
- **Out of scope:** Working memory, server-side semantic validation, automatic divergence merge, raw project IDs or paths, and a second remote credential system.
- **Approach:** Convex stores one immutable ciphertext envelope per Oh operation, indexed by opaque space and sequence; the last row is the remote head, so no second mutable head table is introduced. Push transactionally requires the exact prior sequence and parent digest, while an exact replay succeeds idempotently. The transport is untrusted even after decryption: HRA strictly parses every head and push acknowledgment, caps ciphertext, plaintext, operation count, and operation bytes before Oh, rejects a pull larger than the requested batch, and binds every pulled range to the remote head observed at the start of the round. Sync runs on the concrete canonical `OhSqliteStore` already open under the project coordinator lock—never a cast or second database open—and journals exact control, physical, remote, bundle, and effect-phase evidence before network mutation. One optional daemon sync lane owns every configured space and isolates transient network failure from local reads and working memory. A raced or divergent head freezes that space's sync-dependent canonical work while preserving both histories. Imported pages remain `unverified` unless their portable host-attestation evidence is also synchronized and validated.
- **Acceptance criteria:** Fast-forward push/pull works across two enrolled devices attached to the same random space; replay is idempotent; malformed heads, null/sequence incoherence, oversized or over-count pull bundles, responses past the observed remote range, tampered ciphertext, and invalid operation bytes fail locally; uncertain push reconciles against the exact remote head before any retry; divergence never overwrites either side; transient network failure does not freeze local reads or working memory; every new table appears in exhaustive authority, quota, lifecycle, deletion, revocation, and maintenance inventories.
- **Validation:** Oh transport law tests, deterministic two-device simulations, Convex function/table coverage, quota/retention/deletion tests, and hosted dev integration.

## Phase 9: Add hosted supervisory visibility

- **Status:** Not started
- **Depends on:** phase 8
- **Objective:** Make memory and peer activity legible in the CLI and enrolled browser without expanding mutation authority.
- **Scope:** Shared head/count/kind-key recency, sync/conflict/last-exchange status, effective peer policies, and bounded mutating peer-action metadata. Browser receives only client-encrypted projections and decrypts in the existing enrolled-device boundary. Local CLI status and memory operations already ship in phase 4.
- **Out of scope:** Raw local working memory, full memory bodies in the first browser release, inspect-read logging, provider raw traffic, and browser peer/memory mutation.
- **Approach:** Project only bounded digests, opaque space identifiers, labels, status, counts, and recent kind/key metadata through an optional encrypted device-registry field. The browser never downloads or replays raw Oh history. Keep complete page bodies local until a separate content-retention and browser rendering review.
- **Acceptance criteria:** CLI and app agree on heads/counts/status; actor and target labels cannot be confused; stale or undecryptable projections render a closed unavailable state; no plaintext memory or reason text reaches Convex.
- **Validation:** Projection round trips, browser-safe import checks, app model/component tests, accessibility and keyboard checks, hosted readback.

## Phase 10: Validate and deliver hosted support

- **Status:** Not started
- **Depends on:** phases 8 and 9
- **Objective:** Merge, deploy, and prove the hosted memory transport and supervisory surface.
- **Scope:** Final docs, migration/release metadata, aggregate validation, deployment, production readback, and task closeout evidence.
- **Out of scope:** Automatic conflict merge, cross-project peer authority, and hostile-process isolation.
- **Approach:** Run independent security/change-impact review over local and hosted boundaries, then the exact repository final gate. Follow repository deployment and production verification steps without bypassing provider or repository approvals.
- **Acceptance criteria:** Required checks pass at the merged SHA; hosted schema/functions are deployed; a production encrypted empty-space handshake and bounded round trip succeed; public documentation matches the shipped limits and residual risks.
- **Validation:** Exact-tree `bun run check` through `hra-host-run`; PR/merge checks; hosted deployment scripts; production status and encrypted transport smoke.

## Implementation log

- 2026-09-04, plan revision 1: replaced the supplied plan after repository and package survey. Removed ineffective same-UID PID fencing, schema rewrites, project instruction mutation, fake Work signaling, raw SDK CRUD, automatic publication, and a duplicate libSQL credential path. Added provider-native preambles, stable Oh host/agent authority, same-project default scope, append-only evidence, explicit share, a Claude bridge proof gate, and a two-release HRA delivery train.
- 2026-09-04, plan revision 2: completed the hosted-sync seam audit. Chose a dedicated one-row-per-operation encrypted Convex table rather than session chunks or an extra head table, assigned one optional daemon sync owner, kept local memory available under sync failure, and limited the browser to a bounded encrypted registry summary instead of raw history replay.
- 2026-09-04, plan revision 3: corrected the upgrade story against the pinned Codex schema. `thread/resume` can refresh developer instructions but cannot attach dynamic tools, so legacy threads are not silently presented with a nonfunctional HRA capability facade. New sessions and provider-switched replacement threads admit the manifest and preamble as one durable binding.
- 2026-09-05, plan revision 4: recorded the implemented local memory boundaries without closing a phase. HRA imports stable `@hraness/oh/memory`, exposes memory only through session-bound provider tools, serializes each project's working and canonical operations in one coordinator, retains exact replay evidence for a finite advertised period, freezes unexplained canonical divergence, and aligns fork and transactional SQLite capacity with Oh's 32 MiB memory lane.
- 2026-09-05, plan revision 5: incorporated the owner's request for a non-experimental usable surface and the final adversarial audit. Added the closed owner CLI to the local release, retained strict conflict-by-default adoption, recorded the pending authorization for exact-digest replacement, made the cross-account working-memory restriction explicit, documented sticky freeze and absent erasure/rollover paths, and strengthened the future sync contract around untrusted transport heads, bounded pulls, exact remote-range binding, and uncertain-response recovery.
- 2026-09-05, plan revision 6: replaced the unsustainable permanent peer-action ledger with bounded rolling retention. Added the 120/project/hour aggregate rate, seven-day full-detail window, 25,000-row cap and 4,840-row protected reserve, recursive active/recovery pins, transactional terminal-subgraph pruning, durable queue actor attribution after eligible link detachment, and fail-closed capacity behavior.
