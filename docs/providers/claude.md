# Claude provider notes

Status: the notes below are the W1 spike that the W3-C adapter was built from. The adapter now exists in `src/claude/` (pin, runtime discovery, process, protocol, delta assembler, client) with `src/daemon/claude-runtime-adapter.ts` implementing `ClaudeRuntimePort`. Every mapped shape below is covered by a fixture-driven test in `src/claude/`; nothing shells out to `claude` in tests. The daemon now starts a Claude session end to end: the durable session-start and turn evidence carries either provider's reviewed profile, and the daemon routes every session effect to the port its session's provider binds. Claude account sign-in, provider-side session listing, and resume are still absent, so a Claude session lives only as long as the daemon that started it.

## Shape

A Claude profile is one isolated home exported as `CLAUDE_CONFIG_DIR`. The user installs the exact pinned Claude Code version separately, signs in with `claude auth login` inside that home, and keeps its `claude` executable on `PATH`. HRA locates and version-checks that unmodified runtime before launching it through HRA's environment-allowlisted spawner, and never reads, copies, or forwards the credential. Account selection stays user-directed. Claude profiles default to a per-account cap of two concurrent sessions; swarm-scale traffic may be judged non-ordinary by the provider, and users raise the cap knowingly.

## macOS Keychain probe (plan item D2)

Question: does a detached daemon spawning the runtime under a per-profile `CLAUDE_CONFIG_DIR` read the directory-keyed Keychain item without prompting?

Recorded so far (2026-09-02, Claude Code 2.1.258, macOS):

- A fresh, empty, mode-0700 `CLAUDE_CONFIG_DIR` fully isolates configuration. `claude auth status` runs non-interactively inside it, reports `loggedIn: false`, creates only `.claude.json`, a lock directory, and `backups/`, and does not touch or prompt for the Keychain.
- The machine's login keychain holds one item for the default configuration, service `Claude Code-credentials`.

Pending, requires the owner to sign in interactively inside an isolated profile home:

- Whether the sign-in stores a directory-keyed Keychain item or a file inside the profile home.
- Whether a detached process with no window server session can read that item without a prompt.

Outcome rule from the plan: if prompts occur, Claude ships Linux-first. HRA never stores a `setup-token` or any other credential under any outcome.

## Stream-json contract (captured 2026-09-03)

Spike for the "Providers, models" and Claude Code (W3) sections in [HRA Web v1](../../kb/plans/hra-web-v1.md). Pinned facts for this capture: `claude_code_version` `2.1.260` measured with `claude --version` on this machine (the plan's prior ground truth recorded `2.1.259`; treat the exact version as drifting release to release and keep pinning and failing closed on drift, as the plan already requires). None of this is a published contract.

### CLI surface (`claude --help`)

Relevant flags, verbatim from `claude --help` on `2.1.260`:

- `--effort <level>` - "Effort level for the current session (low, medium, high, xhigh, max)". This is the flag list of common values, not the full legal set: `ultracode` is a real, separate `reasoningEffort` value returned by the protocol's model listing for reasoning-capable models (see below) and is not shown in `--help`; "max without ultracode" means passing `--effort max` specifically.
- `--model <model>` - "Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')." The help text's own example (`claude-fable-5`) is already one version behind what this machine accepts (see below).
- `--output-format <format>` - "(only works with --print): 'text' (default), 'json' (single result), or 'stream-json' (realtime streaming)".
- `--input-format <format>` - "(only works with --print): 'text' (default), or 'stream-json' (realtime streaming input)".
- `--resume [value]` / `-r` - "Resume a conversation by session ID, or open interactive picker with optional search term".
- `--permission-mode <mode>` - "Permission mode to use for the session (choices: 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan')".
- `--dangerously-skip-permissions` - "Bypass all permission checks. Recommended only for sandboxes with no internet access." (Distinct from `--allow-dangerously-skip-permissions`, which only makes the bypass available as an option without enabling it by default.)
- `CLAUDE_CONFIG_DIR`: not a `--help` flag, it is an environment variable read by the bundled runtime; strings found in the installed CLI bundle confirm it must be an absolute path (the process errors with "... is not an absolute path" otherwise), that it selects the whole config/session/credential home (matching this doc's existing Keychain-probe notes), and that the runtime specifically checks whether a spawned child's `CLAUDE_CONFIG_DIR` matches its parent's for transcript-mirroring purposes, i.e. isolation is a first-class, load-bearing concept in the runtime, not an incidental side effect of the env var.

### Fable model id and reasoning efforts

- On this machine, `claude -p ... --model claude-fable-5-1 --effort max --output-format json --max-turns 1` was accepted directly; no fallback to `claude-fable-5` was needed. The result and stream-json `assistant`/`result` events report `"model":"claude-fable-5-1"` and `modelUsage["claude-fable-5-1"] = {canonicalModel:"claude-fable-5-1", provider:"firstParty", contextWindow:1000000, maxOutputTokens:64000, ...}`.
- **The model id itself has drifted between builds.** A `model/list` capture from `get-bb/bb`'s recordings (Claude Code `2.1.238`, 2026-08-21) lists the Fable entry as id `claude-fable-5` ("Fable 5"), with `supportedReasoningEfforts` = `low | medium | high | xhigh | ultracode | max` (each as `{reasoningEffort, description}`) and `defaultReasoningEffort: "high"`. By `2.1.260` (this machine, 2026-09-03) the accepted id is `claude-fable-5-1`. This capture did not re-run `model/list` on this machine (only the `-p` path above), so the full `supportedReasoningEfforts` set for `claude-fable-5-1` specifically is inferred from the `claude-fable-5` capture, not independently reconfirmed; only `max` was directly confirmed to work for `claude-fable-5-1` here. Pin the exact id per deployed `claude_code_version` and re-verify on every Codex/Claude bump, the same way the plan already requires for Codex.
- Unauthenticated behavior (fresh, empty `CLAUDE_CONFIG_DIR`, `--output-format json`): `is_error: true`, `subtype: "success"` (the CLI's own outer envelope, despite the failure), `result: "Not logged in · Please run /login"`, `terminal_reason: "api_error"`, all usage/cost fields zeroed, `session_id` still issued. See `claude-fixtures/output-json-unauthenticated.jsonl.txt`.
- Authenticated, single short turn (this machine's existing login, minimal real spend, owner-approved): `is_error: false`, `stop_reason: "end_turn"`, `terminal_reason: "completed"`, `result: "ok"`, real `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), `total_cost_usd`, and a `modelUsage` map keyed by canonical model id. See `claude-fixtures/output-json-authenticated.jsonl.txt`.

### stream-json event shapes

Captured with `claude -p --output-format stream-json --input-format stream-json --verbose --max-turns 1`, one user line piped on stdin (`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`). Raw, path-redacted event lines: `claude-fixtures/stream-json-single-turn.jsonl.txt`. Event sequence observed for one short turn with hooks configured: `system/hook_started` x N, `system/hook_response` x N (one pair per configured `SessionStart` hook), `system/init` (session bootstrap: `cwd`, `session_id`, `tools`, `mcp_servers`, `model`, `permissionMode`, `slash_commands`, `claude_code_version`, `capabilities`, `memory_paths`), `assistant` (one per completed message; only present without partial deltas unless `--include-partial-messages` is also passed, in which case `stream_event` wrapping raw Anthropic Messages API deltas such as `message_start`/`content_block_start`/`content_block_delta`/`content_block_stop` interleave before the final `assistant` line, as seen in the bb recordings), `rate_limit_event` (`rate_limit_info.status`, `unifiedWindows.{five_hour,seven_day,...}.utilization`), `result` (the same shape as the `-p --output-format json` result above, terminating the process).

### bb wire captures: control protocol, questions, subagents

From `get-bb/bb` (MIT), `packages/provider-bridge-protocol/recordings/claude-code/{approval-allow,approval-deny,user-question,subagent}` (`claude-code 2.1.238`). Curated, redacted examples: `claude-fixtures/bb-control-protocol-examples.jsonl.txt`.

- `control_request` subtypes observed across all recorded cells: `can_use_tool`, `hook_callback`, `initialize`, `mcp_message`, `set_permission_mode`. Only `can_use_tool` is in the plan's current mapping (below); `hook_callback` and `mcp_message` are Claude's own hook/MCP plumbing and `set_permission_mode`/`initialize` are session bootstrap, none currently projected into HRA's provider-neutral interaction model.
- `can_use_tool` request: `{type:"control_request", request_id, request:{subtype:"can_use_tool", tool_name, display_name, input, description, permission_suggestions:[{type:"addRules"|"addDirectories", rules?, directories?, behavior?, destination}], decision_reason_type?, blocked_path?, tool_use_id, requires_user_interaction?}}`. `permission_suggestions` carries candidate persistent-allow rules the *user* could pick, not a grant; `blocked_path` appears when a filesystem boundary caused the ask. `requires_user_interaction: true` was observed set on the `AskUserQuestion` request and is otherwise absent (falsy by omission) on a plain `Bash` ask.
- `can_use_tool` response (bridge to provider): `{type:"control_response", response:{subtype:"success", request_id, response:{behavior:"allow"|"deny", updatedInput?, toolUseID, decisionClassification?, message?}}}`. `allow` echoes (possibly edited) `updatedInput` back as the tool call's actual input; `deny` carries a human-readable `message` and omits `updatedInput`. The plan's autorespond rule (allow only at `once` scope, echoing only the verbatim input) matches this shape exactly: never add `permission_suggestions` to the response, only ever answer with the request's own `input`.
- `AskUserQuestion` is itself a `can_use_tool` call (`tool_name: "AskUserQuestion"`), input `{questions:[{question, header, options:[{label, description}], multiSelect}]}`; the allow response's `updatedInput` adds an `answers` map keyed by the literal question text (`{"<question text>": "<chosen label>"}` for single-select). There is no separate question/answer RPC pair; it is exactly the `can_use_tool` allow flow with the answers folded into `updatedInput`.
- Subagents: `system` events `task_started` (`task_id, tool_use_id, description, subagent_type, is_backgrounded, spawn_depth, task_type, prompt, session_id`), `task_progress` (`task_id, tool_use_id, usage:{total_tokens, tool_uses, duration_ms}, last_tool_name`), `task_updated` (`task_id, patch:{status, end_time, ...}`, not named in the plan's ground truth but present in the wire capture), and `task_notification` (`task_id, tool_use_id, status, output_file, summary, usage`). The parent-child link the plan calls `parent_tool_use_id` is carried on the subagent's own `assistant`/`stream_event` lines (set to the spawning `Task` tool's `tool_use_id`), not inside the `task_*` system events themselves, which key by `task_id`/`tool_use_id` instead.
- Steering: mid-turn steering is a second `{"type":"user","message":{"role":"user","content":"..."}}` line sent on the same input stream while a turn is in flight, exactly as the plan states; the bb `steer` recording shows the runtime accepting a second instruction ("Stop counting now...") after the first ("Count from 1 to 40...") without a new session or turn boundary.

### Event mapping (Claude to HRA)

| Claude event / field | Shape | HRA event body / interaction kind | Notes |
| --- | --- | --- | --- |
| `control_request` `can_use_tool`, `tool_name: "Bash"` | see above | `command_approval` interaction | Matches the plan's mapping. |
| `control_request` `can_use_tool`, `tool_name` in `{Edit, Write, NotebookEdit}` | see above | `file_change_approval` interaction | Matches the plan's mapping. |
| `control_request` `can_use_tool`, any other `tool_name` (no `requires_user_interaction`) | see above | `permission_approval` interaction | Matches the plan's mapping. |
| `control_request` `can_use_tool`, `tool_name: "AskUserQuestion"`, or any `requires_user_interaction: true` | `input.questions[]` | `user_input` interaction, answered via `updatedInput.answers` | Matches the plan's mapping; this is the same envelope as the two rows above, discriminated by `tool_name`/`requires_user_interaction`, not a separate method. |
| second `user` line mid-turn on the input stream | `{type:"user", message:{role:"user", content:...}}` | `send_or_steer` command, resolved at execution time | Matches the plan's mapping. |
| `system` `task_started` / `task_progress` / `task_updated` / `task_notification`, correlated by `parent_tool_use_id` on the child's own message lines | see above | `subagent_activity` event (`started\|interacted\|interrupted` in the plan's vocabulary) | `task_updated` has no named HRA equivalent yet; treat its `patch.status` transitions as additional `interacted`/completion signal alongside `task_notification`. |
| `assistant` (complete message) or, with `--include-partial-messages`, `stream_event` `content_block_delta` (`text_delta`) | message/content-block text | `assistant_delta` (coalesced) | HRA's live-projection uploader (plan, "Live projection (W1)") needs `--include-partial-messages` to get true incremental deltas; without it, only whole-message granularity is available. |
| `stream_event` `content_block_delta` on a `thinking`/reasoning block (not directly observed in this capture; inferred from the Anthropic Messages streaming shape `content_block_start.content_block.type` values) | - | `reasoning_summary_delta` (coalesced, opt-in) | Not confirmed in this capture; verify the exact `content_block.type` for thinking blocks before relying on it. |
| `result` (terminating the process/turn) | see `output-json-*.jsonl.txt` | `turn_completed` / `turn_summary` | `is_error`, `stop_reason`, `terminal_reason`, `result` (text), `usage`, `total_cost_usd` map onto the plan's completion/caveat classification inputs. |
| `system` `init` | see above | session bootstrap (not a per-turn event) | Carries `model`, `permissionMode`, `claude_code_version`; useful for the daemon to confirm which preset/effort is actually active. |
| `rate_limit_event` | `rate_limit_info.{status, unifiedWindows}` | no current HRA mapping | Candidate signal for a future budget/quota surface; out of scope for W1/W3 as planned. |
| `control_request` `hook_callback`, `mcp_message`, `set_permission_mode`, `initialize` | see above | no current HRA mapping | Claude-internal plumbing (hooks, MCP passthrough, bootstrap); the plan's adapter does not need to translate these. |
