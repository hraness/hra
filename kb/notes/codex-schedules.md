---
title: Codex scheduled tasks (automations) ground truth
description: Where Codex Desktop stores recurring "automations" on disk and in local SQLite, how a fired automation lands in a session, and what the app-server protocol does and does not expose for a read-only scheduled-tasks projection.
type: note
status: current
area: hra
tags:
  - codex
  - schedules
  - automations
  - app-server
relations:
  related-to: [ plans/hra-web-v1 ]
---

# Codex scheduled tasks (automations) ground truth

Spike for the "Scheduled tasks (read-only, Codex only)" prerequisite in [HRA Web v1](../plans/hra-web-v1.md#web-app-w2). Measured on this machine: pinned HRA Codex CLI `0.149.0` (`@openai/codex` in `package.json`); the interactively-driven Codex Desktop app on this machine is a newer build (`cli_version` seen in session metadata: `0.151.0-alpha.7.2`). The app-server JSON schema below was generated from the pinned `0.149.0` binary via `codex app-server generate-json-schema --experimental`.

## What exists: "automations" (kind `heartbeat`)

Codex Desktop calls its scheduled-task feature an **automation**. Nothing in this feature is exposed by the app-server RPC protocol (see "App-server exposure" below); it is Desktop-app-owned local state read and written directly on disk and in a local SQLite cache.

**Source of truth: `~/.codex/automations/<id>/automation.toml`**, one directory per automation:

```toml
version = 1
id = "upload-codex-and-claude-usage-to-tokscale"
kind = "heartbeat"
name = "Upload Codex and Claude usage to Tokscale"
prompt = "Upload this machine's local Codex and Claude Code usage data to the saved Tokscale account. Run `...`. Report ..."
status = "ACTIVE"                                              # or "PAUSED"
rrule = "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=22;BYMINUTE=0"       # RFC 5545 RRULE; sometimes prefixed "RRULE:", sometimes not
target_thread_id = "01a06277-c3f2-7360-ab88-e5cdc7aa1504"       # links the automation to a Codex session/thread id
created_at = 1788358694391                                      # epoch ms
updated_at = 1788358694391                                      # epoch ms
```

Three automations were observed on this machine, all `kind = "heartbeat"`; no other `kind` value has been seen, so the schema for non-heartbeat kinds is unknown. `id` is a user/app-chosen slug (same string as the directory name), not a UUID, and can contain anything the automation was named from. `~/.codex/automations/.run-jitter-salt` also exists (a small opaque text file) and is presumably used to jitter fire times across a population of installs; its format was not decoded and it carries no automation-specific data.

**Local SQLite cache: `~/.codex/sqlite/codex-dev.db`** (this machine's active desktop build) and `~/.codex/sqlite/codex.db` (a second, currently-empty copy of the same schema, likely a different build channel) each have:

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

`automations` rows mirror the TOML files and add `next_run_at`/`last_run_at`, which the TOML does not carry. On this machine `automation_runs` and `inbox_items` are both empty (0 rows) even though automations have fired (`last_run_at` is populated), which means the observed `heartbeat` kind does not go through `automation_runs`/`inbox_items` at all: it fires straight into the existing `target_thread_id` as another turn (see below). The `automation_runs`/`inbox_items` schema (keyed by a fresh `thread_id` per run, with an inbox title/summary) looks built for a different, unobserved automation mode that spawns a **new** thread per firing rather than continuing one target thread; the empty `target_type`/`project_id` columns on every `automations` row are consistent with that second mode existing but unused here. Treat this as inferred, not confirmed.

## How a fired automation lands in a session

When a `heartbeat` automation fires, Codex Desktop appends a normal `user_message` turn to the session whose `session_id` (also seen as `id` and, for forked continuations, `forked_from_id` in `session_meta`) equals the automation's `target_thread_id`. That session lives under `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<thread-id-suffix>.jsonl` (a thread can span multiple rollout files across resumes/forks, all sharing the same `session_id`). The injected message text is tagged and self-describing:

```
<heartbeat>
  <automation_id>finish-linkedin-contacts-import</automation_id>
  <current_time_iso>2026-08-16T02:31:21.454Z</current_time_iso>
  <instructions>
  ...the automation's prompt, verbatim...
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

`~/Library/Application Support/Codex` and `~/Library/Application Support/com.openai.codex` were checked and contain only ordinary Chromium/Electron app-shell state (caches, cookies, crash reporting, component updater data); nothing schedule-related lives there. No `LaunchAgents`/launchd plist drives automation firing; it is presumably timed by the running Desktop app process itself (consistent with the jitter-salt file).

## Recommended read-only projection

```ts
type ScheduledTaskProjection = {
  id: string;              // automations.id / automation.toml `id` (user-chosen slug, not a UUID)
  label: string;            // automation.toml `name`
  cadence: string;          // automation.toml / automations.rrule, raw RFC 5545 RRULE, passed through unparsed
  nextRunAt?: number;        // automations.next_run_at (epoch ms) from the local SQLite cache; absent for PAUSED or if the cache is missing/stale
  lastRunAt?: number;        // automations.last_run_at (epoch ms) from the same cache, OR derived by scanning the target session for the newest `<heartbeat><current_time_iso>` tag
  sessionPublicId?: string;  // automation.toml `target_thread_id`, mapped through the daemon's existing Codex session/thread id -> HRA session public id table
  source: "codex";
};
```

Can be derived reliably:
- `id`, `label`, `cadence` (as a raw RRULE string), `status` (ACTIVE/PAUSED), `sessionPublicId`: read directly from `~/.codex/automations/*/automation.toml`. This needs no undocumented SQLite access and is stable as long as the TOML shape holds.
- A firing history for a given automation: scan the target session's rollout files for `<heartbeat>` user messages (works even without the SQLite cache).

Cannot be derived without touching the unstable local SQLite cache, or not derivable at all:
- `nextRunAt` / `lastRunAt` as single numeric fields: only present in `~/.codex/sqlite/codex-dev.db` (or `codex.db`) `automations.next_run_at`/`last_run_at`; the TOML has no equivalent. This is an internal cache with no version guarantee (two near-identical DB files were found, one active and one empty, suggesting the file name/location can shift across Desktop builds); treat any dependency on it as best-effort and fail closed (omit the field) rather than guess.
- A human-readable cadence: rendering "every Monday at 1pm" from the raw RRULE needs an RRULE evaluator; only three concrete shapes have been observed (`FREQ=HOURLY;INTERVAL=n`, `FREQ=WEEKLY;BYDAY=...;BYHOUR=..;BYMINUTE=..`, `FREQ=MONTHLY;BYDAY=..;BYSETPOS=..;BYHOUR=..;BYMINUTE=..;BYSECOND=..`, the last sometimes prefixed `RRULE:`), not the full grammar; scope a real RRULE parser as separate work rather than hand-rolling one from these three samples.
- Any automation whose `kind` is not `heartbeat`, or a "new thread per run" mode: the `automation_runs`/`inbox_items` schema suggests one exists, but no example was observed to confirm its shape or how it would populate `sessionPublicId` (a run's thread would presumably rotate per firing rather than staying fixed).
- A live "currently executing" state for an automation: there is no such field anywhere; it would have to be inferred from whether the target session currently has an active turn.
- Any app-server-native way to do the above: as established, the automations feature is not on the app-server RPC surface at all in the pinned `0.149.0` schema, so a projection built from app-server alone cannot list automations; it must read the local TOML files (and, best-effort, the SQLite cache) directly, the same way HRA already treats other undocumented Codex local state. Pin the exact file/column shapes read and fail closed on drift, per the plan's existing rule for unpublished Codex/Claude contracts.
