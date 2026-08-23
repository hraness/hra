# HRA

```sh
bun add --global github:hraness/hra#v0.1.0
```

```sh
hra init
```

```sh
hra doctor --offline
```

> **Beta not yet live.** The `v0.1.0` tag and hosted sync service are beta-not-yet-live. The install command becomes usable when the beta tag is published.

HRA is one Bun CLI plus a local daemon. It keeps Codex accounts isolated, gives you a compact session interface, and optionally syncs encrypted session projections and commands across your enrolled machines.

[GitHub](https://github.com/hraness/hra) · [Documentation](https://github.com/hraness/hra#command-reference) · [Security](https://github.com/hraness/hra/blob/main/SECURITY.md) · [Privacy](https://github.com/hraness/hra/blob/main/PRIVACY.md)

## First account

```text
hra account add personal
hra account login personal
hra account usage personal --refresh
```

Use `hra account login personal --device-code` when you want the provider's supported device-code path. Otherwise, follow the interactive instructions printed by the CLI. HRA keeps the resulting provider state inside that profile's isolated `CODEX_HOME` without copying `auth.json`.

HRA cloud identity is separate from every Codex account. Use the email-code flow below only after a hosted or self-managed Convex deployment has been configured.

## Cloud sign-in and device pairing

The hosted endpoint is beta-not-yet-live. Until it is published, these commands require an explicit deployment URL in `HRA_CONVEX_URL` before the daemon starts. HRA accepts cloud credentials only as protected JSON on standard input or a nonterminal file descriptor. It rejects email addresses, identity invites, and verification codes on the command line:

```text
hra auth login --input-stdin
hra auth login --input-fd <fd>
hra device pair
hra sync status
```

Each login reads exactly one JSON document. Request a code for an existing identity with `{"email":"you@example.com"}`, create a new identity with `{"email":"you@example.com","invite":"<identity-invite>"}`, or verify a requested code with `{"email":"you@example.com","code":"12345678"}`. No other keys or combinations are accepted. A TTY prompt hides the document; agents should pass a private descriptor with `--input-fd <fd>`. The document is never an argument.

After successful email verification, the daemon automatically registers the current installation before it reads cloud data. The first registered device becomes active and creates the client-side encryption key. A later verified installation is registered as pending and may report presence, but it has no synchronized data, execution, or key authority.

On an already active machine, list devices and approve the pending device by its exact ID or unique prefix:

```text
hra device list
hra device approve <pending-device-id-or-prefix>
```

After approval, run `hra device pair` on the new machine to retrieve and unwrap its encryption-key envelope. Use `hra device revoke <device-id-or-prefix>` from a different active machine to revoke a device.

Cloud-account erasure is explicit and irreversible. Run `hra auth delete --acknowledge-erasure` to disable every cloud effect before bounded server-side removal begins. `hra auth status` recovers capability-only progress after authentication records disappear. Erasure does not delete local Codex accounts, local sessions, or local encryption custody.

## Features

- Isolated accounts: each named profile has its own user-only `CODEX_HOME`. Codex app-server owns login and token refresh; HRA does not copy or parse provider credentials.
- Usage with provenance: account identity, quota, rate-limit, and token snapshots include their provider source time and freshness.
- Compact sessions: list sessions, read user and final assistant messages, inspect elapsed time plus bounded observed file and Git actions, then open one turn for full provider-visible detail.
- Durable controls: send, queue, steer, stop, rename, and keep one editable note per session. Provider and desktop effects use exact authority, idempotency keys, and process-generation fencing.
- Named projects: a project is a canonical directory that may contain several repositories. Changing it affects future turns only.
- Optional encrypted sync: paired devices share a bounded session projection and submit commands to the one machine holding the execution lease.

## Terminal and agent interfaces

Run `hra` in a TTY to open a persistent shell. Account and session selections stay in the prompt, protected answers are read without terminal echo, and `/exit` leaves the daemon running. One-shot commands provide the same control surface to scripts and agents.

```text
hra
hra session status <session> --json
hra session events <session> --cursor <cursor> --limit <1-200> --wait-ms <0-30000> --json
hra session events <session> --cursor <cursor> --wait-ms 30000 --follow
hra session interactions <session> --pending --json
```

JSON mode writes one versioned document to stdout and diagnostics to stderr. Event following writes JSON Lines as the turn progresses. Signed opaque cursors let an agent resume bounded event pages, and durable interaction records keep approvals, questions, permission grants, and MCP elicitation visible until they are explicitly resolved.

## Presets and permissions

HRA refreshes the requested model, reasoning effort, Fast service tier, permission profile, computer-use capability, and enabled accessible apps immediately before each new thread or turn. An unavailable requirement fails before the provider effect. Every successful start records that exact account generation and effective profile; `hra session show` displays it with the condensed transcript. An empty enabled-app list is reported as empty. Codex app-server remains authoritative for permissions, tools, computer use, and plugins.

- `low`: Luna Max, currently `gpt-5.6-luna` with `max` reasoning.
- `high`: Sol Max, currently `gpt-5.6-sol` with `max` reasoning.
- `ultra`: Sol Ultra, currently `gpt-5.6-sol` with `ultra` reasoning.
- `fast on|off`: an explicit per-turn Fast or Standard overlay. A prior Fast value cannot leak into the next turn.

`hra init` asks before making your canonical Documents directory the default project; `hra init --yes` accepts that default non-interactively. Turns use Codex's `auto_review` path, the exact advertised `:workspace` permission profile, and the selected project as the runtime workspace root. Codex remains authoritative for the profile's effective sandbox and network policy and computer use.

## Plugin discovery

```text
hra plugin list <account> [--project <project>] [--refresh]
hra plugin show <account> <plugin> [--project <project>] [--refresh]
```

Plugin commands are read-only discovery. They report the exact installed, enabled, availability, authorization, and capability state exposed by the selected isolated Codex profile.

Pinned Codex 0.149.0 has no safely separated install, enablement, and OAuth lifecycle surface: its available lifecycle path can combine installation with enablement and may then open browser authorization. HRA therefore does not expose plugin install, enable, disable, OAuth, or permission effects. Those actions fail with an explicit protocol-boundary error.

## Desktop account switching

`hra account switch <profile>` is experimental and macOS-only in the first beta. The current compatibility gate accepts only the signed OpenAI ChatGPT application at `/Applications/ChatGPT.app` with reviewed version, build, CDHash, and isolated-profile launch hooks. Unsupported or changed bundles fail before quit.

A switch requires a signed-in target with a verified provider email, takes one machine-global lock, rejects multiple exact app processes, and refuses an unsettled earlier switch. It journals the target generation, gracefully quits the exact process, waits for exit, relaunches once with the target's isolated Codex and desktop-data roots, and binds read-only account verification to that launched PID, executable, CDHash, and environment.

HRA never copies `auth.json`, swaps one token, changes Keychain blindly, rotates accounts to evade a provider limit, or retries an uncertain switch. An uncertain quit, transition, or relaunch becomes `recovery_required` and preserves both profiles. Run `hra account switch-recover` to reconcile only the current attempt. Recovery performs bounded read-only bundle, process, environment, and account observations; it never quits or launches the app. It releases the switch authority only when those observations prove the target account is active or prove that no target instance remains.

## Sessions across machines

The machine that created a provider session remains its only executor in v1. It must be online with its HRA daemon running and must hold the current execution lease before a remote command can affect Codex. Other paired machines never execute that provider session through their own local Codex profile.

Paired machines can read the encrypted projection and submit bounded send, queue, steer, stop, preset, and Fast commands. The origin daemon claims each command by lease generation and idempotency key. Commands remain pending within their deadline while the origin machine is offline; another machine cannot take over or become a second provider writer.

```text
hra remote list
hra remote show <cloud-session>
hra remote command <uuidv7>
hra remote send <cloud-session> <message>
hra remote queue|steer <cloud-session> <message>
hra remote stop <cloud-session>
hra remote preset <cloud-session> <low|high|ultra>
hra remote fast <cloud-session> <on|off>
```

A cloud-session selector accepts an exact public ID, a unique public-ID prefix, or an exact synced name. HRA resolves that selector to the session's exact execution device before enqueueing. Remote mutations accept `--idempotency-key <current-uuidv7>` for explicit lost-response recovery; otherwise the CLI creates one and durably recovers an unsettled encrypted outbox entry before accepting a different command. Every enqueue returns its command ID. Use `hra remote command <uuidv7>` to read its bounded current or terminal state and result code, including a failed or ambiguous outcome.

Transcript upload is bound to a durable local stream ledger and the exact remote head and tail. Missing or mismatched evidence pauses upload for only that session. Remote reads, commands, and usage continue, while `hra sync status` keeps the recovery condition visible. HRA never resets, aliases, overwrites, or destructively reseeds encrypted history.

```text
hra sync projection recover <local-session-selector> --acknowledge-gap [--idempotency-key <current-uuidv7>] [--json]
```

Projection recovery is an explicit append-only operation. Running it without `--acknowledge-gap` performs no daemon call and returns `INTERACTION_REQUIRED` with the exact safe next command. JSON mode never prompts. The acknowledged operation preserves all older encrypted cloud history and changes no provider or app state. It opens the next compact stream epoch at sequence `H+1`, where `H` is the exact remote compact head, and baselines only completed turns currently visible in the bounded local projection. Any possibly unsynced interval remains visible to remote readers as a recovery gap.

The CLI creates a current UUIDv7 before daemon transport. Success reports the phase, local session, old and new epochs, boundary head, persistent gap, and an exact same-key replay command. Reuse that command after a lost response. Changed-key retry remains closed while the first recovery is unsettled.

Session names and notes sync as encrypted metadata, but v1 does not execute remote rename or note commands. Project directories are local-only and are neither synced nor remotely changed.

## Privacy

Cloud sync is optional. Local account profiles, Codex credentials, and local execution continue to work without it. HRA identity is separate from every Codex account.

### Encrypted before upload

- User messages and final assistant display text.
- Session names, notes, queued messages, and steering input.
- Turn timing, observed model and tier, and provider usage summaries.
- Bounded observed file and Git metadata, without unbounded filesystem paths.
- Remote-command input and results that fit the closed command protocol.

### Never uploaded

- Codex credentials, profile files, plugin credentials, or OAuth material.
- Raw app-server requests or responses.
- Raw reasoning, hidden chain of thought, or approval secrets.
- Environment variables, arbitrary command output, or unbounded filesystem paths.

The sync service necessarily sees the verified HRA email address, device identifiers, record types, revisions, ciphertext sizes, timestamps, and execution-lease or command lifecycle metadata. It cannot decrypt session content without a paired device key. Email access alone does not recover that key.

Compact-projection recovery is append-only. It preserves every older encrypted cloud chunk, opens a new stream epoch, and keeps the acknowledged unsynced interval visible as a recovery gap until authenticated account deletion.

The website uses no analytics, cookies, remote fonts, or executable JavaScript. Codex activity remains subject to OpenAI's own service and privacy terms.

> **Hosted sync status.** The hosted sync endpoint is beta-not-yet-live. Authenticated account deletion and capability-only progress recovery are implemented and pass deterministic hostile tests. Fresh-deployment and live completion acceptance remain launch gates.

## Command reference

```text
hra init [--yes] [--json]
hra doctor [--offline] [--json]
hra auth login --input-stdin|--input-fd <fd>
hra auth status|logout
hra auth delete --acknowledge-erasure
hra device list|pair
hra device approve|revoke <device-id-or-prefix>
hra account add <label>
hra account login <profile> [--device-code]
hra account logout <profile>
hra account list
hra account show <profile>
hra account usage [profile] [--refresh]
hra account switch <profile>
hra account switch-recover
hra plugin list <account> [--project <project>] [--refresh]
hra plugin show <account> <plugin> [--project <project>] [--refresh]
hra project add --path <directory> [--name <name>]
hra project list
hra project use <project>
hra session list [--account <profile>] [--limit <1-100>]
hra session show <session> [--detail]
hra session status <session>
hra session events <session> [--cursor <cursor>] [--limit <1-200>] [--wait-ms <0-30000>] [--follow]
hra session interactions <session> [--pending] [--limit <1-100>]
hra session start <account> [--project <project>] [--preset <low|high|ultra>] [--fast]
hra session send|queue|steer <session> <message>
hra session stop <session>
hra session rename <session> <name>
hra session recover|abandon <session>
hra session note get|edit|clear <session>
hra session note set <session> <note>
hra session preset <session> <low|high|ultra>
hra session fast <session> <on|off>
hra session project <session> <project>
hra interaction list [session] [--pending] [--limit <1-100>]
hra interaction show <interaction-id>
hra interaction decide <interaction-id> --revision <n> --decision <once|session|decline|cancel>
hra interaction grant|answer <interaction-id> --revision <n> --input-stdin|--input-fd <fd>
hra interaction submit <interaction-id> --revision <n> --action <accept|decline|cancel> [--input-stdin|--input-fd <fd>]
hra remote list [--limit <1-100>]
hra remote show <cloud-session>
hra remote command <uuidv7>
hra remote send|queue|steer <cloud-session> <message>
hra remote stop <cloud-session>
hra remote preset <cloud-session> <low|high|ultra>
hra remote fast <cloud-session> <on|off>
hra turn inspect <session> <turn> [--json]
hra sync status|now
hra sync projection recover <local-session-selector> --acknowledge-gap [--idempotency-key <current-uuidv7>] [--json]
hra daemon start|status|stop|run
```

Account, project, and local-session selectors accept an exact ID or an unambiguous case-insensitive label. Cloud-session selectors accept an exact public ID, a unique public-ID prefix, or an exact synced name. Device selectors accept an exact ID or unique prefix. Ambiguity lists candidates and performs no effect. The CLI creates and sends an idempotency key before every provider effect; pass `--idempotency-key <uuid>` to reuse one after a lost response. session recover accepts only exact, kind-specific provider proof. session abandon never retries or deletes provider state and releases only the local recovery authority. Remote mutations require a current UUIDv7 when this option is supplied. With `--json`, stdout contains one versioned object; diagnostics stay on stderr.

Projection recovery uses the local-session selector rules. It requires `--acknowledge-gap` and a current UUIDv7, generated by the CLI when omitted. The same-key command is safe to replay after a lost response; a changed key cannot overtake unsettled recovery authority.

The beta does not expose destructive local profile or project deletion. `account logout` asks Codex app-server to remove that profile's provider login while HRA preserves its local session history.

## Authority boundaries

Codex app-server remains authoritative for provider login, transcripts, turns, tools, approvals, models, plugins, and usage. HRA owns isolated profiles, durable commands, process generations, local projections, optional encrypted sync, and recovery records.

Cloud service availability is not required for local login, local execution, local recovery, or reading local sessions. Multiple Codex accounts remain independent subscriptions. HRA does not pool quota or replay a limited turn under another account.

## Project

HRA is MIT licensed. Read the [security policy](https://github.com/hraness/hra/blob/main/SECURITY.md) before reporting a vulnerability, use [private vulnerability reporting](https://github.com/hraness/hra/security/advisories/new) for suspected security issues, and read the [contribution guide](https://github.com/hraness/hra/blob/main/CONTRIBUTING.md) before a large change.
