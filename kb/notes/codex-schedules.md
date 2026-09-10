---
title: Codex scheduled tasks (automations) ground truth
description: Where Codex Desktop stores recurring automations, how they land in sessions, and why their metadata stays private except for a narrow local adoption age gate.
type: note
status: current
area: oompa
tags:
  - codex
  - schedules
  - automations
  - app-server
relations:
  related-to: [ plans/oompa-web-v1 ]
---

# Codex scheduled tasks (automations) ground truth

Ground truth for the local adoption age-gate integration. The original protocol probe used Oompa's then-pinned Codex CLI `0.149.0` and generated its app-server JSON schema with `codex app-server generate-json-schema --experimental`; current compatibility remains governed by the repository's reviewed pin and schema digests. Every task name, prompt, thread id, path, and timestamp below is synthetic and carries no operator data.

## What exists: "automations" (kind `heartbeat`)

Codex Desktop calls its scheduled-task feature an **automation**. Nothing in this feature is exposed by the app-server RPC protocol (see "App-server exposure" below); it is Desktop-app-owned local state read and written directly on disk and in a local SQLite cache.

**Source of truth: `~/.codex/automations/<id>/automation.toml`**, one directory per automation:

```toml
version = 1
id = "weekly-project-maintenance"
kind = "heartbeat"
name = "Weekly project maintenance"
prompt = "Review the registered project and report any maintenance work."
status = "ACTIVE"                                              # or "PAUSED"
rrule = "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=22;BYMINUTE=0"       # RFC 5545 RRULE; sometimes prefixed "RRULE:", sometimes not
target_thread_id = "00000000-0000-4000-8000-000000000001"       # links the automation to a Codex session/thread id
created_at = 1700000000000                                      # synthetic epoch ms
updated_at = 1700000000000                                      # synthetic epoch ms
```

Only `kind = "heartbeat"` has been verified; the schema for any other kind remains unknown. `id` is a user/app-chosen slug (the same string as the directory name), not necessarily a UUID, and can derive from the automation's name. Desktop also maintains a small opaque `.run-jitter-salt` beside the automation directories; its format was not decoded and it carries no automation-specific data.

**Local SQLite cache:** inspected Desktop builds have used `~/.codex/sqlite/codex-dev.db` or `~/.codex/sqlite/codex.db` with this relevant schema:

```sql
CREATE TABLE automations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  next_run_at INTEGER,      -- epoch ms; present for ACTIVE rows, null for PAUSED
  last_run_at INTEGER,      -- epoch ms; null until the automation has fired at least once
  cwds TEXT NOT NULL DEFAULT '[]',   -- JSON array of working-directory strings
  rrule TEXT NOT NULL DEFAULT 'FREQ=HOURLY;INTERVAL=24;BYMINUTE=0',
  model TEXT, reasoning_effort TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  target_type TEXT, project_id TEXT   -- added by a later migration; empty on every observed row
);

CREATE TABLE automation_runs (
  thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL,
  read_at INTEGER, thread_title TEXT, source_cwd TEXT,
  inbox_title TEXT, inbox_summary TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived_user_message TEXT, archived_assistant_message TEXT, archived_reason TEXT
);

CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY, title TEXT, description TEXT, thread_id TEXT, read_at INTEGER, created_at INTEGER
);
```

`automations` rows mirror the TOML files and add `next_run_at`/`last_run_at`, which the TOML does not carry. Verified `heartbeat` behavior fires straight into the existing `target_thread_id` as another turn (see below), without requiring an `automation_runs` or `inbox_items` row. The latter tables are keyed by a fresh `thread_id` per run and carry inbox fields, so they appear intended for a different, unverified mode that creates a new thread per firing. Treat that interpretation as an inference, not a contract.

## How a fired automation lands in a session

When a `heartbeat` automation fires, Codex Desktop appends a normal `user_message` turn to the session whose `session_id` (also seen as `id` and, for forked continuations, `forked_from_id` in `session_meta`) equals the automation's `target_thread_id`. That session lives under `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<thread-id-suffix>.jsonl` (a thread can span multiple rollout files across resumes/forks, all sharing the same `session_id`). The injected message text is tagged and self-describing:

```
<heartbeat>
  <automation_id>weekly-project-maintenance</automation_id>
  <current_time_iso>2030-01-02T03:04:05.678Z</current_time_iso>
  <instructions>
  Review the registered project and report any maintenance work.
  </instructions>
</heartbeat>
```

So a session's transcript itself is a second, always-available source for "was an automation fired here, and when": scan `event_msg` records of `payload.type == "user_message"` whose `message` starts with `<heartbeat>`, and read the embedded `automation_id` and `current_time_iso`. This does not require the SQLite cache and survives it being absent or a different build's cache being empty.

## A distinct, easily-confused mechanism: per-thread goals

Codex also has a per-thread **goal** (objective + budget) tracker, unrelated to scheduling but overlapping in vocabulary (status values, "active", timestamps): event type `thread_goal_updated` with payload `{ type, threadId, goal: { threadId, objective, status, tokenBudget?, tokensUsed, timeUsedSeconds, createdAt, updatedAt } }`, `status ∈ {active, paused, blocked, usageLimited, budgetLimited, complete}` (app-server) / `active|paused|blocked|usage_limited|budget_limited|complete` (SQLite). Backed by `~/.codex/goals_1.sqlite`, tables `thread_goals` (`thread_id` PK, `goal_id`, `objective`, `status`, `token_budget`, `tokens_used`, `time_used_seconds`, `created_at_ms`, `updated_at_ms`) and `thread_goal_continuation_deferrals`. A goal is 1:1 with a thread, has no `rrule`/cadence, and is not itself a schedule; do not conflate it with automations when building the projection. The app-server schema defines `ThreadGoalSetParams`/`ThreadGoalGetParams`/`ThreadGoalClearParams`/`ThreadGoalUpdatedNotification`/`ThreadGoalClearedNotification` types (pinned `0.149.0`), but no wired `method` string for them was found in the generated schema dump, so whether they are reachable over the current app-server connection is unconfirmed.

## App-server exposure (generated schema, pinned `0.149.0`, `--experimental`)

Searched the generated schema (`codex app-server generate-json-schema --out ... --experimental`, 401 type files plus the combined `codex_app_server_protocol.v2.schemas.json`) for `schedule`, `automation`, `cron`, `recurring`, `goal`, `heartbeat`:

- **No RPC method family exists for the `~/.codex/automations` heartbeat automations described above.** No `automation/*` or `schedule/*` method, no request/response pair that lists, reads, creates, pauses, or deletes them, and no notification for a firing. They are Desktop-app-internal, filesystem- and SQLite-backed only.
- There **is** a different, non-overlapping `ScheduledTask*` type family (`ScheduledTaskSummary { key, name, prompt, schedule }`, `ScheduledTaskSchedule` = one of `HourlyScheduledTaskSchedule { intervalHours, days? }` / `DailyScheduledTaskSchedule { time }` / `WeekdaysScheduledTaskSchedule { time }` / `WeeklyScheduledTaskSchedule { days, time }`, `ScheduledTaskWeekday` = `MO..SU`), but it appears only as `PluginDetail.scheduledTasks` inside the response of `plugin/read`. This describes scheduled tasks a **plugin manifest declares it wants to register** (no thread/session id field at all), not a live per-user automation. It is a lookalike name, not the same feature; do not build the projection from it.
- The only reachable RPC surface adjacent to "recurring work" is `plugin/list`, `plugin/read`, `plugin/search`, `plugin/install`, `plugin/installed`, `plugin/uninstall`, none of which return the user's actual automations.

The inspected Desktop build kept schedule authority under the Codex home rather than its ordinary Chromium/Electron app-support state, and no launchd plist drove firing. Timing therefore appears owned by the running Desktop process, consistent with the jitter-salt file; that mechanism is an inference and not part of Oompa's authority contract.

## Session-adoption trigger

Personal-home session adoption uses one additional narrow consequence of this
mapping: a present, valid `heartbeat` record with an exact nonblank
`target_thread_id` makes that Codex thread discoverable even when it falls
outside the ordinary recent-session window. Both `ACTIVE` and `PAUSED` records
count because pausing does not delete the task or its conversation binding;
deletion or retargeting removes the trigger. Oompa opens and locally parses the
bounded TOML document, but it never selects, retains, logs, returns, or projects
`prompt`, `cwds`, or another ignored field. It reads no transcript for this
decision.

Authority discovery advances through a private live directory cursor. If that
cursor expires, its safe raw position reconstructs the reader without granting
authority until the reconstructed cursor is consumed. After a daemon restart,
the first bounded page rotates by the unbounded daemon generation; an offset
beyond the current directory wraps over its raw cardinality in constant memory
and under the same absolute deadline instead of falling back to a fixed first
page ring. If an unusually large directory cannot reach its offset or EOF before
that deadline, the pass yields no authority and a later pass retries. Exact-source
rechecks still decide whether an individual target has authority, so directory
churn can delay discovery but cannot turn a stale offset into a positive claim.

The automation is only an age-gate hint. Oompa obtains the exact target through
metadata-only `thread/read`, without resuming it during discovery, and then
requires the ordinary account, registered-project, timestamp, liveness,
quiescence, collision, and exact-resume proofs. It re-reads the association
around claim. The Codex Desktop task remains owned by Codex Desktop; Oompa adopts
its target conversation as an ordinary Oompa session and does not convert the
record into an Oompa conversation task. Claude has no equivalent schedule source.

## Privacy and sync boundary

Codex Desktop automation data is private provider-home input. Oompa may read the
minimum TOML association needed to waive only the recent-session age limit
during personal-session discovery, then it rechecks that association around
claim. The automation does not become an Oompa schedule, and adoption does not
create a public schedule origin marker.

The encrypted device registry and app-facing scheduled-task list contain only
ordinary Oompa conversation tasks from Oompa's session-task store. They never
contain a Desktop automation's id, name, RRULE, status, target thread, mapped
session correlation, firing history, or SQLite timing fields. This remains true
when the target conversation is adopted: native and adopted Oompa task rows have
the same public shape and no provider-home source field.

After Desktop fires a task, its exact provider-generated heartbeat user
envelope may appear in the ordinary Codex transcript. The Codex projection
boundary replaces that whole envelope with generic `[protected]` text in
compact messages, detailed items, preview-derived titles, and live thread-name
facts. The automation id, firing timestamp, instructions, and any
schedule-specific origin marker therefore never enter public or cloud state;
an exact envelope echoed by the assistant or a reasoning summary is protected
too. Plausible live prefixes stay in bounded local staging until the item
boundary proves or rejects the whole envelope, while near-matching user,
assistant, or reasoning-summary text retains its ordinary semantics.

Readers discard the legacy `codex_automation` registry rows emitted by earlier
builds. Writers canonicalize the registry before encryption so even a stale
in-process caller cannot re-sync those fields. The only adoption data allowed in
that encrypted registry is the exact Codex and Claude Code provider-level
`enabled`, `pending`, `adopted`, and `fenced` aggregate. Devin has no adoption
key, and candidate records and identities stay local.
