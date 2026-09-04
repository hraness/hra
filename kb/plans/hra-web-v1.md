---
title: HRA Web v1: session grid, steering, autorespond, open beta
description: Plan for the first real HRA web app (a mobile-friendly grid of live sessions with steering, approvals, model choice, archive), the session-state classifier and autoresponder that feed it, Claude Code as a second provider, and opening hosted sign-up.
type: plan
status: proposed
area: hra
revision: 2
created: 2026-09-03
tags:
  - web
  - sessions
  - autorespond
  - claude
  - signup
relations:
  related-to: [ plans/hra-v2, notes/web-ux ]
---

# HRA Web v1

Revision 2 folds in two adversarial reviews (security and custody; feasibility, cost, and UX) recorded at the end of this document.

## Owner decisions this plan encodes (2026-09-03)

1. Hosted sync is **not invite-only**. Anyone can sign up with an email and a one-time code.
2. The web app is a **grid of sessions**: cards that show the last prompt and the streaming result; tapping a card opens it with a steering input (no queue UI). A wide "new session" input sits above the grid; a settings icon button sits to its left in the top-left corner; a kebab menu on each card archives it; the settings view lists archived sessions and unarchives them. Drag-and-drop ordering. It must work well on mobile touch devices.
3. Defaults when using the UI: model preset **Sol Ultra**, approvals **always approve**; a switch to **Claude Fable at max reasoning effort, never ultracode**.
4. **Autorespond**, enabled by default: every assistant turn is classified; when a turn merely asks for approval (permission to proceed, or a verbatim approval string), a model replies on the human's behalf. Be lenient. Turns that genuinely need a human are marked with a glowing animated orange border and the required action highlighted.
5. Every turn carries a session state that drives the UI; the important states are "human input required" and the flavours of "complete".
6. Render thinking and model output as streaming markdown; tool calls need not be rendered; running subagents must be visible.
7. Approvals must be wired correctly for Codex and Claude Code, including provider permission prompts that appear even under auto-approve.
8. Account linking from the web UI if possible; otherwise clear CLI instructions.

These supersede two HRA v2 decisions: a browser device may now approve (F9 sign-off is this section), and the keyboard-first TUI contract in [web-ux](../notes/web-ux.md) is replaced by the grid contract below. Everything else in HRA v2 stands: the local daemon is the only execution authority, everything hosted is end-to-end encrypted, one additive envelope, provider-neutral vocabulary, raw reasoning never leaves the machine.

Owner-accepted risks, named so they are not re-litigated: (a) a browser device that is unlocked can approve `once`-scope decisions and send steering text; (b) sessions can be started on the owner's machine from the web, guarded as described under device commands; (c) account linking from the web is a relayed login behind a local opt-in flag; (d) with approvals set to `all`, network and MCP permission prompts are auto-accepted too.

## Ground truth (2026-09-03 audit, measured)

- No web app exists; `site/` is a static generator. Remote viewing is CLI-only (`hra remote ...`).
- Hosted model: `sessionHeads`, encrypted `sessionChunks` on streams `compact | detail` (`detail` is fully wired in the schema, `appendChunk`, and head sequences but never produced), compact events `user_message`, `assistant_message`, `interaction_state`, `turn_summary`; remote `sessionCommands` of kind `send|queue|steer|stop|set_model|set_fast` executed by the custodian under an execution lease; device wrapping keys and the account key envelope. Chunk retention class is `encrypted_history`: never swept; quota only releases on account deletion. Compact chunks are digest-chained, so pruning needs the stream-epoch mechanism.
- The daemon syncs on a polling lifecycle, default 15 s (clamped 1 to 60 s), one `#appendCompact` per session per cycle inside a budgeted optional task, each append preceded by a metadata update and head read and CAS on head sequence and tail digest. Commands are processed first in each cycle. The daemon uses `ConvexHttpClient` only, so there are no subscriptions. Steering latency from a phone today is therefore 0 to 15 s.
- Local daemon events include `assistant_delta`, `reasoning_summary_delta`, `turn_started`, `turn_completed`, `interaction_requested`, `interaction_state`. Codex approvals arrive as app-server server requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`) and become durable interaction records answered locally; the runtime profile pins `approvalPolicy: on-request`; file-change approvals are refused because pinned Codex 0.149.0 supplies no diffs; `effectiveRuntimeProfileSchema` hard-fails any model and effort pair other than the preset's; the compact projection bakes `ModelPreset = low|high|ultra` into `turn_summary.model`. Remote interaction resolution does not exist; `commandKind` is a closed union; the per-session command FIFO blocks successors behind a prepared head; `nonterminal_command` quota is 256 per user.
- Codex wire facts (0.149 binary on this machine): decisions `accept | acceptForSession | decline | cancel` with `availableDecisions` per request; `approvalPolicy` `untrusted | on-request | never | {granular}`; `sandboxMode` `read-only | workspace-write | danger-full-access`; `turn/start` takes `model` and `effort`; `model/list` returns ordered `supportedReasoningEfforts`; subagent items `subAgentActivity` (`started|interacted|interrupted`, `thread_spawn{parent_thread_id, depth, agent_nickname, agent_role}`) exist in the protocol but HRA's digest-pinned notification matrix carries no subagent notification, so subagent visibility needs a Codex bump and a reviewed matrix re-pin. Proactive multi-agent fan-out is gated on `ultra` effort. Local models: `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`; no mini model is observed.
- Claude Code 2.1.259 is installed here with `--effort <level>`, `--model`, `--output-format stream-json --input-format stream-json`, `--resume`. bb's wire captures (MIT, `github.com/get-bb/bb`) show `control_request {subtype: "can_use_tool", tool_name, input, permission_suggestions, tool_use_id, requires_user_interaction}` answered by `control_response {behavior: "allow" | "deny", updatedInput}`; `AskUserQuestion` as a `can_use_tool` answered by echoing `updatedInput` with an `answers` map keyed by question text; subagents via `system/task_started`, `task_progress`, `task_notification` and `parent_tool_use_id`; steering by writing another `user` line mid-turn; `supportedReasoningEfforts` `low, medium, high, xhigh, ultracode, max` (ultracode is an effort value, so "max without ultracode" is effort `max`). Model id seen: `claude-fable-5`; read the exact id locally. None of this is a published contract: pin `claude_code_version` and fail closed on drift.
- Sign-up: `convex/authDelivery.ts` requires an invite in three places (`reserveEmailAttempt`, `storeOtpChallenge`, `consumeOtpChallenge`); `requireAuthAdmissionsOpen` also gates verify and device pairing, so freezing admissions locks out existing users; OTP via Resend (free tier 100 per day); `SERVICE_TOTAL_QUOTA.identities = 500` enforced as hard authority (a stored counter above the constant is corrupt); service ceiling 25 M records and 100 GiB; per-user 2 GiB and 250,000 chunks, so about 100 fully used users exhaust the service.
- Corpus (23,699 prose turns from this machine, 89 hand-labelled): mean assistant text 812 chars, median 479, p90 1,809; median turn 269 s, p90 4,919 s. Labels: 50% clean completions, 14% completion with caveats or failure, 9% followups, 9% still working after the turn ended, 8% approval asks, 9% blocked on a human action, 0 pure questions. The current lexical rules agree 73% overall and 83% on attention classes; 2 of 8 human-action turns classify as approvals, which is the one harmful direction.
- Web tooling: React 19.2 and `@types/react` are devDependencies; `tsconfig` includes only `src|convex|scripts|site|plugins` `*.ts`, so `app/` would be outside typecheck, test, and `check`. The F1 CSP `style-src 'self'` blocks inline style attributes. `vercel.json` is one project and `docs/hosted-sync.md` pins its Vercel project id in the identity guard.

## Architecture

```
browser (app.hra.sh) ── Convex (encrypted projection + commands) ── daemon (Mac/Linux) ── Codex app-server / claude stream-json
```

The daemon remains the only execution authority. The web app is an enrolled browser device that decrypts the projection client-side and submits commands; the daemon executes them, classifies turns, and autoresponds. Nothing hosted ever sees plaintext.

### Live projection (W1)

- Reuse the existing `detail` stream for live text; no third stream literal. A dedicated per-session streaming uploader runs outside the sync cycle, reuses the held execution lease, keeps its own head-sequence cursor, and batches at **1,000 ms or 8 KiB with a forced flush on `turn_completed`**. Events: `turn_started`, `assistant_delta` (coalesced), `reasoning_summary_delta` (coalesced, only when the session's "show thinking" setting is on), `subagent_activity`, `session_state`.
- Reasoning summaries are **off by default** and enabled per session or globally from settings; raw reasoning is never uploaded. PRIVACY.md and the invariant registry gain an explicit row for summaries when enabled.
- Redaction before encryption: `redactAbsolutePaths` and the secret-value patterns (extended with `sk-ant-`, `ghp_`, `AKIA`) run over each batch with a 256-byte carry-over window so a path or token split across batches cannot pass both checks.
- Retention: `detail` chunks get a new retention class `live_tail` (current and previous turn, at most 200 rows per session), a cron sweeper that releases quota, and pruning through a detail stream epoch so the digest chain stays verifiable. New per-user sub-quota `live_chunk` = 20,000 rows. Expected load with text only: about 15 to 30 chunks and 10 KB per turn; with summaries on, 5 to 10 times more, which the sub-quota bounds.
- Compact events become versioned: parsers accept and ignore unknown optional keys, mixed-version decode is tested, and the compact `user_message` gains `actor: "human" | "autorespond"`.
- `session_state` carries `{state, attention, reason, verbatimRequired, lastActivityAt, revision}`; a later revision always wins; the head metadata mirrors the latest so lists render without decrypting chunks.

### Session state model

| `state` | Meaning | UI |
| --- | --- | --- |
| `working` | A turn is active, or the turn ended but the agent is monitoring, waiting on subagents, or a background job. | Neutral border, streaming text, subagent chips. `stale` presentation after 30 minutes without a provider event, with a one-tap "mark needs me". |
| `needs_approval` | The turn asks for consent only. With autorespond on, transient. | Amber dot while transient; orange glow if autorespond is off, refused, or over budget. |
| `needs_answer` | A genuine question or choice: `item/tool/requestUserInput`, `AskUserQuestion`, MCP elicitation, a Claude request with `requires_user_interaction`, or a trailing question in prose. | Orange glowing border; question and options highlighted; answer field. |
| `needs_action` | The human must do something in the world (log in, paste a code, attach a file, run a command). | Orange glowing border; the requested action highlighted. |
| `done` | Finished, nothing asked. | Quiet. |
| `done_followups` | Finished with optional next steps offered. | Quiet, "next steps" affordance. |
| `done_caveats` | Finished with a stated failure or residual blocker. | Muted red dot. |
| `aborted` | Turn interrupted or failed. | Muted red dot. |

`attention` is true for `needs_answer`, `needs_action`, and `needs_approval` when autorespond will not act; the daemon emits a second `session_state` revision after every responder outcome, including refusal. Card indicators follow one priority ladder: unread error, waiting for input, working, subagents running, done with caveats, done with followups, done, none.

Classification order (first match wins), over the final assistant message with fenced code and blockquotes stripped and the tail taken as the last 600 characters of the last two paragraphs, plus protocol facts:

1. Provider status `interrupted | failed` → `aborted`.
2. Pending provider interaction → by kind: closed approvals → `needs_approval`; `requestUserInput`, `AskUserQuestion`, elicitation, `requires_user_interaction` → `needs_answer`.
3. Human-action cues anywhere in the message ("on your phone", "log in", "verification code", "one-time code", "paste the", "scan the QR", "attach", "reply done") → `needs_action`. Evaluated before approval cues so "authorize the charge on your phone" never becomes an approval.
4. Denylist cues anywhere in the message (payment, credentials, deleting production data, sending email or messages to third parties, transfers) → `needs_answer`.
5. Approval cues in the tail ("do you approve", "please authorize", "reply with", "needs explicit approval", "awaiting your approval", a blockquoted or bold literal to paste back sets `verbatimRequired`) → `needs_approval`.
6. Trailing question with no approval framing → `needs_answer` (kept although the corpus has no positives; it only adds attention, never an autoresponse).
7. Progress cues, an open subagent, or an armed monitor → `working`.
8. Failure verdict cues → `done_caveats`.
9. Recommendation and offer cues → `done_followups`.
10. Else `done`.

Rules 1 to 7 are lexical and ship first. Rules 8 to 10 may be refined by one small model call when a gateway key is configured. Automation turns (heartbeats, guardian reviews, subagent threads) are excluded from the human-facing state.

Tests: a fixture of `{sha256(message), length, label, expectedRule}` rows derived from the 89 hand labels plus hand-written paraphrases per rule; a digest of the classification vector regenerated by a script so rule changes show as diffs; and a hard gate that **no human-action-labelled row classifies as `needs_approval`**. Prose autorespond ships only after that gate holds; protocol-approval autorespond ships first.

### Autorespond (W1 protocol path, W2 prose path)

- **Protocol approvals** (Codex server requests, Claude `can_use_tool`): with the session's approval mode `auto`, the broker answers immediately with **`accept` at `once` scope only** (Codex `accept`, never `acceptForSession`; Claude `behavior: "allow"` echoing only the verbatim `input`, never `permission_suggestions` or updated permissions) and records an interaction in state `resolved` with `resolvedBy: "autorespond"`. Codex stays on `on-request` so every approval is observed and evidenced. File-change approvals are accepted under `auto` (owner accepts the missing-diff limitation). An approval mode `workspace` exists that auto-accepts commands and file changes but escalates network, MCP, and unknown-tool permissions; the owner's default is `all`. A Claude request with `requires_user_interaction: true`, or an unrecognised tool with the flag absent, is never auto-allowed.
- **Prose approvals** (`needs_approval` from text): a positive gate must hold: the tail matched a high-precision approval cue, no pending interaction of an excluded class exists, no human-action or denylist cue matched anywhere, and the message is under 4,000 characters. The responder then produces the reply. When `verbatimRequired`, the daemon extracts the literal itself and refuses the send unless the responder's output is a byte-exact substring of the last assistant message; on mismatch the state escalates to `needs_answer`. Otherwise the reply is "The human has approved. Proceed accordingly." Replies go through the ordinary `send` path with `actor: "autorespond"`.
- **Responder model**: the Vercel AI Gateway path is the default (`openai/gpt-5-nano`, `reasoningEffort: minimal`, `Output.choice` for classification refinement, about $0.0002 per turn) with a key entered in settings and stored in local secret custody; prose autorespond activates only once a key is configured. A helper thread on the session's own Codex account is a W3 fallback behind an explicit `helper` runtime-profile variant, since the reviewed profile schema and per-account serialization refuse it today, and it would spend subscription turns.
- **Budgets and evidence**: at most one autoresponse per turn; a consecutive counter that resets only on a human-authored message escalates to `needs_answer` at 3; per-session budgets of 10 per hour and 40 per day; subagent-originated approvals are counted separately. Every action writes a local evidence record (input tail digest, rule, decision, model, latency, outcome) in a new store table that `hra autorespond status` reads.

### Remote decisions and commands (W1)

- New command kinds `resolve_interaction` and `send_or_steer` are added to the closed unions with a versioned validator. `resolve_interaction` carries an encrypted `{interactionId, revision, decision}` for `command_approval`, `file_change_approval`, and `permission_approval` with `decision ∈ {once, decline, cancel}`, or `{interactionId, revision, answers}` for `user_input` and `mcp_elicitation` questions that are not marked `secret`. Session-scope decisions and secret answers stay local-only. `send_or_steer` is resolved by the daemon at execution time, since the browser's view of "turn active" is stale.
- Before applying a remote decision the daemon verifies: the interaction is `pending`, belongs to the command's session, the decision is in `availableDecisions`, the requesting device is still active, the local lease is held, and the deadline has not passed; result codes distinguish `INTERACTION_ALREADY_RESOLVED` from failure. Decisions get their own scheduling lane, exempt from the per-session head-blocking FIFO.
- Blind approval from the browser: the projection carries `commandClass` and the bounded summary, never exact command text or permission values; a browser may approve only when a `commandClass` is present and the daemon re-verifies the class at apply time; otherwise the card says "resolve on <machine>" with no button.
- Push wake: the daemon opens a websocket `ConvexClient` subscription on pending commands for its device that wakes the cycle, with an adaptive timer (1 s while a browser device is present or any session is active, 15 s idle). Target steering latency from a phone: under 1 s.
- Interactions carry a provider-neutral `presentation` (label, glyph, headline, markdown detail, options) computed by the daemon and sanitised like all projection text, so the web renders any approval or question without a tool-name table.

### Device commands (W3)

`deviceCommands` is a new table, port, and authority model (commands are session-indexed today). Kinds: `session_start{accountPublicId, projectPublicId, prompt, preset, provider}` executed as start-then-send under one idempotency key with correct quarantine of the ambiguous case; `account_login_start{accountPublicId}` and `account_login_status`; `usage_refresh`. Prerequisites: a projected registry of accounts and projects with cloud public ids and labels (never paths). Guards: per-device kill switch `hra remote deny device-commands`, per-day cap, a local desktop notification on the first `session_start` from each device, browser-started sessions inherit the project's approval mode, and `account_login_start` works only when `hra remote allow account-linking` was set locally; the relayed URL is account-key encrypted, single-use, and short-lived, and the fallback is one-way status polling with CLI instructions.

### Providers, models

- Codex: presets stay `low|high|ultra`; UI default `ultra` (Sol Ultra). Model and effort changes from the web use `set_model`. Subagent activity needs a Codex bump to a version whose notification matrix HRA re-pins, then `subagent_activity` events (`started|interacted|interrupted`, nickname, role, depth) are projected (W3).
- Claude Code (W3): a second port implementation spawning the pinned `claude` binary with stream-json in and out under an isolated `CLAUDE_CONFIG_DIR`, translated through a small delta assembler (bb's "bridge knows the dialect, runtime knows the timeline" split). `can_use_tool` maps Bash to `command_approval`, Edit/Write/NotebookEdit to `file_change_approval`, everything else to `permission_approval`; `AskUserQuestion` to `user_input`; `system/task_*` and `parent_tool_use_id` to `subagent_activity`; steering writes a `user` line mid-turn. Preset `fable-max` = the local Fable model id with effort `max`. Adding a preset changes the encrypted projection format, so the compact parser is versioned first (W1).
- Model routing (HRA v2 section E) stays out of scope.

### Open sign-up (end of W2, with the app)

- Remove the invite requirement at all three call sites behind one `newIdentityAdmissions` control on `serviceControl`, checked only where a new `authSubjects` row is inserted; `authAdmissions` stays the break-glass for everything. Invites remain an optional path.
- Quotas: raise `SERVICE_TOTAL_QUOTA.identities` to 5,000 only together with a beta free tier per user (200 MiB, 50,000 chunks, 20,000 live chunks) and a deliberate service ceiling raise; deploy the authority change before opening admissions.
- Abuse controls: per email 3 sends per 15 minutes and 5 per day, a lifetime cap of 10 sends for addresses that never verify, service-wide 200 sends per hour and 1,000 per day, one active identity per verified email, a global daily new-identity cap of 200. Budget a paid Resend plan.
- Public copy changes from "invite-only beta" to "open beta".

### Web app (W2)

`app/`: Vite, React 19, TypeScript, Tailwind v4, shadcn/ui primitives, Convex React client with the in-memory auth storage adapter (F5). Markdown through `react-markdown` + `remark-gfm` with no raw HTML, a scheme allowlist (`https` only), `img-src 'none'`, bidi and zero-width neutralisation, and stable component identities; streaming is a re-render problem solved by memoising completed blocks. Layout is CSS grid (single column on phones); drag-and-drop ordering with `react-grid-layout` v2 (touch `threshold`) is W3 after verifying the pinned version on React 19 and adding `style-src-attr` handling or class-based positioning. Separate Vercel project on `app.hra.sh` with the F1 CSP plus Convex origins; `docs/hosted-sync.md` gains the second project id. `tsconfig`, `bun test`, `build:app`, and `check` are extended so the app is gated.

Screens:

- **Grid.** Top bar: settings icon button, then the wide "Start a new session" input (W2: sends to the selected idle session or the most recent one; W3: starts a new session through `deviceCommands`). Cards: title, last prompt (two lines), streaming tail (last ~40 lines, auto-follow), subagent chips (W3), state indicator, kebab (archive, rename, copy id). Attention cards get the animated orange border and float to the front of their group. Offscreen cards pause rendering.
- **Session.** Full transcript (compact history plus live tail); thinking summaries collapsible when enabled; tool calls collapsed to one-line markers; approval and question panels with buttons; bottom input (`send_or_steer`); header menu with model switch (Sol Ultra / Fable in W3) and approval mode.
- **Scheduled tasks (read-only, Codex only).** Requested 2026-09-03: a session view shows a badge above the chat with the Codex scheduled tasks associated with that session, and the badge opens a details view; settings lists every Codex scheduled task, associated with a session or not. Display only; creation, editing, and deletion stay in the chat. Prerequisite (W1 spike): identify where Codex stores schedules and which app-server method or file exposes them, then project a `scheduled_tasks` registry (labels, cadence, next run, linked session public id) from the daemon. Ships in W2 settings list and W3 session badge.
- **Settings.** Archived sessions with unarchive; autorespond global toggle and per-session overrides; gateway key; show-thinking default; default preset; machines and their online state; accounts (W3 linking, CLI instructions until then); devices with revoke; sign out and lock.

Custody: approvals and steering require an unlocked in-memory key in the current tab; persisted keys never approve; idle lock drops the key; a browser device is never the first device and enrollment needs an active device's approval with a displayed fingerprint.

Mobile: single column, explicit drag handle (W3), inputs pinned above the keyboard, safe-area insets, 44 px targets.

## Invariants (new rows)

- The grid renders only decrypted projection text; no plaintext persists beyond the tab; markdown never renders raw HTML or non-https URLs.
- A command submission binds the expected custodian device; a decision binds `interactionId` and `revision` and is verified against the list above.
- Autorespond never uses session scope, never answers `needs_answer` or `needs_action`, never emits a verbatim string that is not a byte-exact substring of the message, and leaves an evidence record for every action.
- Reasoning summaries are uploaded only when enabled; raw reasoning never.
- Provider secrets, exact command text under blind approval, and permission values never enter the projection.
- Device commands cannot run when the per-device kill switch is set; account linking cannot start without the local opt-in.

## Waves

| Wave | Scope | Exit criteria |
| --- | --- | --- |
| W1 daemon and hosted foundation | Streaming uploader on `detail` with coalescing, redaction carry-over, `live_tail` retention with sweeper and epoch pruning, live sub-quota; versioned compact events with `actor`; `session_state` classifier (rules 1 to 7 lexical, 8 to 10 lexical first) and `hra session state`; approval modes `auto (all | workspace) | manual`, protocol-approval autorespond with evidence and budgets, `hra autorespond on|off|status`; `resolve_interaction` and `send_or_steer` kinds, decision lane, verification list, `hra remote resolve`; push-wake subscription and adaptive interval; interaction `presentation`. | Classifier fixture tests pass with the zero human-action-to-approval gate; interaction and command tests; live-stream projection and retention tests; steering latency measured under 1 s with a second device; deployed through the attested candidate chain. |
| W2 web app and open sign-up | `app/` in the gate; browser enrollment with the custody rules; grid, session view, `send_or_steer`, decisions, archive and settings, gateway key entry and prose autorespond, show-thinking toggle; `app.hra.sh` origin, CSP, second Vercel project in the runbook; invariant tests; open sign-up with the controls above and public copy. | Owner uses the grid daily from phone and Mac; two-device live acceptance recorded; sign-up works without an invite. |
| W3 providers and reach | Codex bump with re-pinned matrices and subagent chips; Claude adapter with `fable-max` and the model switch; `deviceCommands` with `session_start`, account-linking relay, `usage_refresh`; drag-and-drop ordering; helper-thread responder fallback; polish. | Claude session started from the web, steered, approved automatically; account linked from the web; subagents visible for both providers. |

Every hosted change is a separate attested deploy through the candidate chain (`docs/hosted-sync.md`), not a step in a PR. Each wave records its evidence below.

## Execution state

| Wave | State | Evidence |
| --- | --- | --- |
| W1 | Implemented 2026-09-04 on `claude/w1` (rebased over v0.3.0 and the conversation scheduled tasks of PR 91; store schema version 30) | Live projection on the `detail` stream (batcher with redaction carry-over, one-second live loop, `live_tail` retention, sweeper, epoch pruning, `live_chunk` quota); session-state classifier with the content-free corpus fixture (81% agreement, full attention recall, zero human-action rows as approvals) and `hra session state`; approval modes with protocol autorespond, evidence, budgets, and `hra autorespond`; `resolve_interaction` and `send_or_steer` with the decision lane, custodian verification, requesting-device gate, and `hra remote resolve`; interaction `presentation`; spikes recorded in `kb/notes/codex-schedules.md` and `docs/providers/claude.md`. Deferred from W1 to the start of W2: the websocket push-wake and adaptive interval (steering latency stays at the poll interval until then). |
| W2 | Not started | - |
| W3 | Not started | - |

## Review log

Revision 1 was reviewed on 2026-09-03 by two independent reviewers. Adopted: restrict remote decisions and require the verification list; `once` scope only for autorespond; human-action and denylist cues before approval cues; daemon-side verbatim check; positive gate and budgets; reasoning summaries opt-in; redaction carry-over; `detail` stream reuse with a retention class, sweeper, epoch pruning, and sub-quota; versioned compact events; dedicated decision lane; push-wake subscription; `send_or_steer`; stale detection and revisioned state; the zero false-approval test gate; per-user beta quotas and a separate new-identity kill switch with all three invite call sites; gating `app/` in `check`; CSP style handling; deferring drag-and-drop, device commands, account linking, subagents, and the helper-thread responder. Rejected with owner acceptance: withdrawing browser approvals, dropping web session start, dropping account linking, and excluding network permissions from `all` auto-approval.
