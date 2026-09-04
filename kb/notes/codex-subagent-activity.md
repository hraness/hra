---
title: Codex subagent activity on the pinned app-server
description: What Codex 0.153.2 does and does not expose about spawned subagents over the app-server protocol, and exactly which parts HRA projects as subagent_activity.
type: note
status: current
area: hra
tags:
  - codex
  - subagents
  - app-server
  - web
relations:
  related-to: [ plans/hra-web-v1 ]
---

# Codex subagent activity on the pinned app-server

Ground truth for the "subagent chips" item of W3 in [HRA Web v1](../plans/hra-web-v1.md#providers-models). Everything below was read from the TypeScript bindings the pinned executable emits with `codex app-server generate-ts --experimental`, compared against the same output from the previously pinned `0.149.0`.

## What the pin bought

The pin moved `0.149.0` to `0.153.2`, the newest exact release (`0.154.0` exists only as `alpha` prereleases, which the bump tool refuses). The `ServerNotification` union gained six methods and lost none:

| Method | HRA disposition | Why |
| --- | --- | --- |
| `mcpServer/event/stream/notification` | `ignored` | Arbitrary MCP server payload; HRA never retains foreign tool output. |
| `modelProvider/authRecoveryStarted` | `ignored` | Provider credential recovery; authentication stays Codex's. |
| `modelProvider/authRecoveryCompleted` | `ignored` | Same. |
| `thread/realtime/item/started` | `ignored` | Realtime audio threads, like every other `thread/realtime/*`. |
| `thread/realtime/item/transcript/delta` | `ignored` | Same. |
| `thread/realtime/item/completed` | `ignored` | Same. |

Three tracked schema files changed digest (`ServerNotification.ts`, `ClientRequest.ts`, `v2/ThreadResumeParams.ts`); both reviewed matrix digests changed, the notification one also because HRA reclassified `thread/started` (below).

## What the release does and does not expose about subagents

The important finding is that **none of the six new notifications is about subagents**, and **subagent visibility did not arrive with this release**: the same surface already existed at `0.149.0`. There is no `subagent/*` notification family in any pinned release, and no method that reports a live roster of running subagents. What exists is:

- **`ThreadItem` variant `subAgentActivity`** — `{ type, id, kind, agentThreadId, agentPath }` with `kind ∈ started | interacted | interrupted | completed` (`SubAgentActivityKind`). It appears on the **parent** thread's item stream, so it arrives over the already-routed `item/started` and `item/completed` notifications and through `thread/listItems`. It carries no nickname, no role, and no depth. `agentPath` is a filesystem path to an agent definition file.
- **`Thread` fields `parentThreadId`, `agentNickname`, `agentRole`** and **`source: SessionSource`**, whose `subAgent → thread_spawn` variant carries `parent_thread_id`, `depth`, `agent_path`, `agent_nickname`, `agent_role`. A `Thread` reaches the connection on `thread/started`, whose params are `{ thread: Thread }`.
- `ThreadSourceKind` (`subAgent`, `subAgentReview`, `subAgentCompact`, `subAgentThreadSpawn`, `subAgentOther`), `MultiAgentMode`, and `ApprovalsReviewer: guardian_subagent` — configuration and analytics vocabulary, not activity.

So the plan's expectation that a bump would deliver a subagent notification family is not met by any released version. The bump is still worth taking, and the activity signal is real; it simply comes from thread items rather than from a dedicated notification.

## What HRA projects

- `thread/started` moved from `ignored` to `reduced`. A thread with no `parentThreadId` is still discarded. A spawned subagent thread reduces to a `subagentThreadStarted` fact **keyed by the parent thread id**, so it routes to the HRA session that owns the spawning conversation, carrying only `agentThreadId` and the bounded `depth`, `nickname`, and `role`.
- `item/started` and `item/completed` for a `subAgentActivity` item carry the activity onto the existing item fact and project as `subagent_activity` instead of a generic item row. `agentPath` is never parsed or retained: it is a local absolute path, and the agent's identity is already the thread id.
- The domain event is `{ type: "subagent_activity", turnId, agentId, kind, depth?, nickname?, role? }`. `turnId` and `agentId` are projected through the opaque public provider identifier, so no raw Codex thread id reaches storage or the cloud. `nickname` and `role` are bounded to 120 UTF-8 bytes, stripped of control scalars, path-redacted, and secret-redacted; anything still unsafe is dropped rather than repaired. Prompts, tool arguments, and agent instructions are never projected.
- One activity is announced on **both** the started and the completed notification of the same marker item, and a thread start may repeat the `started` kind that the item also reports. Every consumer therefore folds by agent id: `SessionStateTracker` keeps a membership set (so `openSubagents` rises and falls without double counting) and the browser model replaces the entry for that agent, keeping labels a later, label-free activity omits.

## Unverified without a live provider run

Whether the app-server actually emits `thread/started` for an internally spawned subagent thread is not provable from the bindings. If it does not, `subagent_activity` still flows from the `subAgentActivity` items and the chips simply show no nickname, role, or depth. Confirm during the `docs/live-acceptance.md` gate with a session that fans out.
