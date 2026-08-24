# HRA

```sh
bun add --global https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz
```

```sh
hra doctor --offline
```

```sh
hra init --yes
```

> **Beta not yet live.** The `v0.1.0` tag and hosted sync service are beta-not-yet-live. The install command becomes usable when the beta tag is published.

HRA is one Bun CLI plus a local daemon. It keeps Codex accounts isolated, gives you a compact session interface, and optionally syncs encrypted session projections and commands across your enrolled machines.

[GitHub](https://github.com/hraness/hra) · [Documentation](https://github.com/hraness/hra#command-reference) · [Security](https://github.com/hraness/hra/blob/main/SECURITY.md) · [Privacy](https://github.com/hraness/hra/blob/main/PRIVACY.md)

## Install, update, and remove

HRA requires Bun 1.3.14. The CLI and local daemon support macOS and Linux; supported ChatGPT desktop account switching is macOS-only. Native protected-input control loads only when a terminal prompt needs it and supports the standard macOS, glibc, and x64 or arm64 musl library names. Install one reviewed immutable tag, then verify the binary before initialization:

```text
bun --version
bun add --global https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz
hra --version
hra doctor --offline
```

Before replacing the installed binary, stop the persistent daemon and confirm that its old process has released authority. The command below performs a verified repair installation of v0.1.0. For a future update, replace both v0.1.0 occurrences in the URL with the exact reviewed release version, verify it, then restart explicitly. Do not install a moving branch for a release machine:

```text
hra daemon stop
hra daemon status --json
bun add --global https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz
hra --version
hra doctor --offline
hra daemon start
```

Removing the package does not remove HRA's local profiles, session history, recovery evidence, or cloud account. Log out each Codex profile and complete any intended cloud-account deletion before uninstalling. Then stop the daemon, confirm that it is stopped, and remove the installed command:

```text
hra daemon stop
hra daemon status --json
bun remove --global hra
```

## First account

```text
hra account add personal
hra account login personal
hra account usage personal --refresh
hra account usage-history personal --limit 50 --json
```

Account login is always a dedicated one-shot invocation, including while the persistent shell is running. Use `hra account login personal --device-code` in a foreground TTY for the provider's device-code path. The code and verification URL are shown only on that protected foreground terminal. HRA keeps the resulting provider state inside that profile's isolated `CODEX_HOME` without copying `auth.json`.

JSON and noninteractive callers must create an empty mode-0600 file under a canonical current-user-owned mode-0700 directory, then pass its absolute canonical path:

```text
hra account login personal --device-code --handoff-file /absolute/private/login.json --json
```

HRA opens and holds the parent and file, resolves the account selector to one exact local account ID, and dispatches login only for that authority. It validates the returned account, state, cancellation command, URL, and device-code shape, writes one versioned login document through the held descriptor, verifies it with fsync and readback, and closes both descriptors before returning only the path and cleanup disposition on stdout. The caller reads the file through its protected boundary and removes it after login. A same-key replay never claims or rewrites a handoff. While login is pending it reports that one-time instructions are unavailable; after completion or cancellation it reports the terminal account state.

If the first pending-login handoff is lost or the daemon restarts before completion, `hra account show personal` reports the pending attempt. Then run `hra account login-cancel personal`. A caller that retained the idempotency key may retry it without redispatching. A still-pending replay cannot recover the one-time code or URL; a completed or canceled replay returns terminal signed-in or signed-out evidence instead of stale pending state. HRA cancels only that profile's exact current-generation provider login before allowing a fresh login. Verification URLs and device codes never enter HRA state, logs, or ordinary output; only the caller-owned protected handoff file retains them for completion.

`hra account usage` keeps the latest snapshot and 1-, 5-, and 15-minute observed token velocity. `hra account usage-history <profile>` reads the retained 24-hour local ledger in durable source order. Use UTC RFC3339 `--from` and `--through` bounds plus the returned opaque cursor for later pages; a cursor freezes that account and range and expires after five minutes. History rows contain only derived token observations or closed poll-failure codes; raw provider payloads are never returned.

HRA cloud identity is separate from every Codex account. Use the email-code flow below only after a hosted or self-managed Convex deployment has been configured.

## Cloud sign-in and device pairing

The hosted endpoint is beta-not-yet-live. An unset `HRA_CONVEX_URL` selects HRA's hosted deployment. Set it to an explicit empty value before the first daemon starts to disable cloud transport. A nonempty HTTPS value selects a self-managed Convex deployment. The first valid selection permanently binds that local state root; a later mismatch fails closed instead of moving credentials or recovery state. HRA accepts cloud credentials only as protected JSON on standard input or a nonterminal file descriptor. It rejects email addresses, identity invites, and verification codes on the command line:

```text
hra auth login --input-stdin
hra auth login --input-fd <fd>
hra device pair
hra sync status
```

Each login reads exactly one JSON document. Request a code for an existing identity with `{"email":"you@example.com"}`, create a new identity with `{"email":"you@example.com","invite":"<identity-invite>"}`, or verify a requested code with `{"email":"you@example.com","code":"12345678"}`. No other keys or combinations are accepted. A TTY prompt hides the document; agents should pass a private descriptor with `--input-fd <fd>`. The document is never an argument.

The CLI stores HRA's revocable device credential, workspace encryption key, and local signing authority as immutable generations below its private state root. Custody directories are current-user-owned mode-0700 directories, values are single-link mode-0600 files, and reads use bounded no-follow descriptors. The detached Bun daemon never opens a Keychain prompt. HRA forces both pinned Codex credential stores to file mode and verifies their effective settings, so Codex credentials remain separately owned by each profile's isolated `CODEX_HOME`.

After successful email verification, the daemon automatically registers the current installation before it reads cloud data. The first registered device becomes active and creates the client-side encryption key. A later verified installation is registered as pending and may report presence, but it has no synchronized data, execution, or key authority.

On an already active machine, list devices and approve the pending device by its exact ID or unique prefix:

```text
hra device list
hra device approve <pending-device-id-or-prefix> [--idempotency-key <current-uuidv7>]
```

After approval, run `hra device pair` on the new machine to retrieve and unwrap its encryption-key envelope. Use `hra device revoke <device-id-or-prefix>` from a different active machine to revoke a device.

Approve and revoke create one current UUIDv7 before daemon transport. If the response is lost after dispatch, HRA prints the exact same-key replay command. Reusing that command recovers the original operation; changing the device or operation under the same key is rejected.

Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked.

Cloud-account erasure is explicit and irreversible. Run `hra auth delete --acknowledge-erasure` to disable every cloud effect before bounded server-side removal begins. `hra auth status` recovers capability-only progress after authentication records disappear. Erasure does not delete local Codex accounts, local sessions, or local encryption custody.

## Features

- Isolated accounts: each named profile has its own user-only `CODEX_HOME`. Codex app-server owns login and token refresh; HRA does not copy or parse provider credentials.
- Usage with provenance: account identity, quota, rate-limit, and token snapshots include their provider source time and freshness. A bounded source-ordered 24-hour ledger supports safe human and JSON pagination without returning raw provider payloads.
- Compact sessions: list sessions, read user and final assistant messages, inspect elapsed time plus bounded observed file and Git actions, then open one turn for full provider-visible detail.
- Durable controls: send, queue, steer, stop, rename, and keep one editable note per session. Provider and desktop effects use exact authority, idempotency keys, and process-generation fencing.
- Named projects: a project is a canonical directory that may contain several repositories. Changing it affects future turns only.
- Optional encrypted sync: paired devices share a bounded session projection and submit commands to the one machine holding the execution lease.

## Terminal and agent interfaces

Run `hra` in a TTY to open a persistent shell. Account and session selections stay in the prompt, live updates redraw wrapped partial input without moving its logical cursor, protected answers are read without terminal echo, and `/exit` leaves the daemon running. Pasted command lines use a bounded queue. An overflow or interrupted line flushes the current native terminal queue, retains input custody while discarding through EOF, and exits without executing the tail. Protected terminal documents require a visible stderr TTY plus unpredictable begin and return phrases while raw no-echo mode is active. A failed protected boundary keeps echo disabled while discarding the tail, then closes shell input instead of returning ambiguous bytes to an ordinary prompt. Display loss, termination, and job-control signals restore or fence raw mode before propagation. Live display is buffered while a foreground or protected prompt owns the terminal, and updates from an old session generation are discarded before a new selection is announced. Slow-terminal backpressure drops additional updates behind one explicit omission notice instead of growing memory without bound. One-shot commands provide the same control surface to scripts and agents.

Selected-session monitoring starts at the atomic status cursor. The shell drains every signed pending-interaction continuation page before following newer events from that cursor. HRA always surfaces bounded lifecycle, tool, interaction, warning, error, and terminal updates. It renders assistant and provider-visible reasoning-summary text only after observing that item's start boundary, then redacts credentials and absolute paths with state carried across chunks and interleaved events. A mid-item join omits ambiguous delta suffixes until the next item starts. Gaps, shutdown, malformed repeated starts, and exhausted redaction capacity discard undecided tails with an explicit notice rather than releasing text whose boundary cannot be proved.

```text
hra
hra session status <session> --json
hra session events <session> --cursor <cursor> --limit <1-200> --wait-ms <0-30000> --json
hra session events <session> --cursor <cursor> --wait-ms 30000 --follow
hra session interactions <session> --pending --json
hra interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]
```

JSON mode writes one versioned document to stdout and diagnostics to stderr. Event following writes JSON Lines as the turn progresses. Signed opaque cursors let an agent resume bounded session-list, event, and interaction pages, and durable interaction records keep approvals, questions, permission grants, and MCP form elicitation visible until they are explicitly resolved.

`interaction show` intentionally returns only a durable safe summary. Before approving a command or permission request, run `hra interaction inspect <interaction-id> --revision <n>` to read the complete authority still held by the live provider callback. A foreground human receives bounded detail on the protected stderr terminal. An agent or other noninteractive caller must first create an empty mode-0600 regular file under a current-user-owned mode-0700 directory and pass its absolute canonical path with `--handoff-file`; ordinary stdout receives only safe binding and cleanup metadata. On macOS, neither the directory nor file may have an extended ACL, and HRA rechecks both held descriptors before and after writing. Detail larger than 64 KiB also requires this file path. Read it within that protected boundary and remove it after deciding. HRA rejects file-change approval callbacks before durable admission because pinned Codex 0.149.0 does not provide the exact affected paths or change detail needed for informed approval.

## Presets and permissions

HRA refreshes the requested model, reasoning effort, Fast service tier, permission profile, computer-use capability, and enabled accessible apps immediately before each new thread or turn. An unavailable requirement fails before the provider effect. Every successful start records that exact account generation and effective profile; `hra session show` displays it with the condensed transcript. An empty enabled-app list is reported as empty. Codex app-server remains authoritative for permissions, tools, computer use, and plugins.

- `low`: Luna Max, currently `gpt-5.6-luna` with `max` reasoning.
- `high`: Sol Max, currently `gpt-5.6-sol` with `max` reasoning.
- `ultra`: Sol Ultra, currently `gpt-5.6-sol` with `ultra` reasoning.
- `fast on|off`: an explicit per-turn Fast or Standard overlay. A prior Fast value cannot leak into the next turn.

`hra init` reports the required confirmation without changing local state; `hra init --yes` explicitly accepts your canonical Documents directory as the default project. Initialization is a one-shot maintenance command: run it before opening the persistent shell. The shell rejects `/init` because its running daemon already owns local state. Turns use Codex's `auto_review` path, the exact advertised `:workspace` permission profile, and the selected project as the runtime workspace root. Codex remains authoritative for the profile's effective sandbox and network policy and computer use.

## Plugin discovery

```text
hra plugin list <account> [--project <project>] [--refresh]
hra plugin show <account> <plugin> [--project <project>] [--refresh]
```

Plugin commands are read-only discovery. They report the exact installed, enabled, availability, authorization, and capability state exposed by the selected isolated Codex profile.

Pinned Codex 0.149.0 has no safely separated install, enablement, and OAuth lifecycle surface: its available lifecycle path can combine installation with enablement and may then open browser authorization. HRA therefore does not expose plugin install, enable, disable, OAuth, or permission effects. The pinned tool-suggestion form that can invoke that compound plugin or connector lifecycle is also rejected before admission. Other standard MCP forms are brokered only when their pinned schema fits HRA's closed primitive-field contract. The interaction exposes bounded field names, types, requiredness, constraints, and allowed choices; titles, descriptions, defaults, and answers stay off the public and durable display. Protected submissions are checked for exact required fields, types, bounds, formats, choices, and the absence of additional properties before response preparation. Opaque openai/form, unsupported schema constructs, and URL elicitation fail before durable admission and receive a safe unsupported-capability response with no schema, submitted value, or URL echo. The schema-11 security migration terminalizes and replaces any prerelease URL record before interaction reads. HRA will keep extended-form and URL handoff unavailable until each has a closed protected path.

## Desktop account switching

`hra account switch <profile>` is experimental and macOS-only in the first beta. The current compatibility gate accepts only the signed OpenAI ChatGPT application at `/Applications/ChatGPT.app` with reviewed version, build, CDHash, and isolated-profile launch hooks. Unsupported or changed bundles fail before quit.

A switch requires a signed-in target with a verified provider email, takes one machine-global lock, rejects multiple exact app processes, and refuses an unsettled earlier switch. It journals the target generation, gracefully quits the exact process, waits for exit, relaunches once with the target's isolated Codex and desktop-data roots, and binds read-only account verification to that launched PID, executable, CDHash, and environment.

HRA never copies `auth.json`, swaps one token, changes Keychain blindly, rotates accounts to evade a provider limit, or retries an uncertain switch. An uncertain quit, transition, or relaunch becomes `recovery_required` and preserves both profiles. Run `hra account switch-recover` to reconcile only the current attempt. Recovery performs bounded read-only bundle, process, environment, and account observations; it never quits or launches the app. It releases the switch authority only when those observations prove the target account is active or prove that no target instance remains.

## Sessions across machines

The machine that created a provider session remains its only executor in v1. It must be online with its HRA daemon running and must hold the current execution lease before a remote command can affect Codex. Other paired machines never execute that provider session through their own local Codex profile.

Paired machines can read the encrypted projection and submit bounded send, queue, steer, stop, preset, and Fast commands. The origin daemon claims each command by lease generation and idempotency key. Commands remain pending within their deadline while the origin machine is offline; another machine cannot take over or become a second provider writer.

`hra remote show` includes observation-only interaction events with a public interaction ID, kind, state, revision, blocking status, and bounded safe summary. Provider request IDs, permission values, MCP fields, protected answers, and response digests remain local. Resolve a pending callback on its execution device; remote interaction responses are unavailable in v1.

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
- Codex account labels and observed provider email and plan metadata when cloud sync is enabled.
- Turn timing, observed model and tier, and provider usage summaries.
- Bounded observed file and Git metadata, without unbounded filesystem paths.
- Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.
- Remote-command input and results that fit the closed command protocol.

### Never uploaded

- Codex credentials, profile files, plugin credentials, or OAuth material.
- Raw app-server requests or responses.
- Raw reasoning, hidden chain of thought, or approval secrets.
- Provider login and request IDs, permission values, MCP field contracts, protected answers, or response digests.
- Environment variables, arbitrary command output, or unbounded filesystem paths.

The sync service necessarily sees the verified HRA email address, device identifiers, record types, revisions, ciphertext sizes, timestamps, and execution-lease or command lifecycle metadata. It cannot decrypt session content without a paired device key. Email access alone does not recover that key.

HRA uses Convex to authenticate the HRA identity and store server-visible metadata plus encrypted projections. Convex receives the verified email address and the service metadata described above, but not the keys required to decrypt session content.

HRA uses Resend to deliver verification email. Resend receives the recipient email address, sender identity, one-time verification code and message content, and ordinary delivery metadata. It receives no Codex credentials or encrypted session projection.

Vercel serves hra.sh. GitHub hosts the source repository, releases, and release downloads. When you visit or download from either service, that provider receives ordinary web request metadata such as the requested URL, IP address, user agent, and time. HRA does not add analytics, cookies, remote fonts, or executable JavaScript to the site.

Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked.

Compact-projection recovery is append-only. It preserves every older encrypted cloud chunk, opens a new stream epoch, and keeps the acknowledged unsynced interval visible as a recovery gap until authenticated account deletion.

Codex activity remains subject to OpenAI's own service and privacy terms.

> **Hosted sync status.** The hosted sync endpoint is beta-not-yet-live. Authenticated account deletion and capability-only progress recovery are implemented and pass deterministic hostile tests. Fresh-deployment and live completion acceptance remain launch gates.

## Command reference

```text
hra init [--yes] [--json]
hra doctor [--offline] [--json]
hra auth login --input-stdin|--input-fd <fd>
hra auth status|logout
hra auth delete --acknowledge-erasure
hra device list|pair
hra device approve|revoke <device-id-or-prefix> [--idempotency-key <current-uuidv7>]
hra account add <label>
hra account login <profile> [--device-code] [--handoff-file <absolute-path>] [--idempotency-key <uuid>]
hra account login-cancel <profile>
hra account logout <profile>
hra account list
hra account show <profile>
hra account usage [profile] [--refresh]
hra account usage-history <profile> [--from <UTC-RFC3339>] [--through <UTC-RFC3339>] [--limit <1-100>] [--cursor <cursor>]
hra account switch <profile>
hra account switch-recover
hra plugin list <account> [--project <project>] [--refresh]
hra plugin show <account> <plugin> [--project <project>] [--refresh]
hra project add --path <directory> [--name <name>]
hra project list
hra project use <project>
hra session list [--account <profile>] [--limit <1-100>] [--cursor <cursor>]
hra session show <session> [--detail]
hra session status <session>
hra session events <session> [--cursor <cursor>] [--limit <1-200>] [--wait-ms <0-30000>] [--follow]
hra session interactions <session> [--pending] [--limit <1-100>] [--cursor <cursor>]
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
hra interaction list [session] [--pending] [--limit <1-100>] [--cursor <cursor>]
hra interaction show <interaction-id>
hra interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]
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

Account, project, and local-session selectors accept an exact ID or an unambiguous case-insensitive label. Cloud-session selectors accept an exact public ID, a unique public-ID prefix, or an exact synced name. Device selectors accept an exact ID or unique prefix. Ambiguity lists candidates and performs no effect. The CLI creates and sends an idempotency key before every provider effect; pass `--idempotency-key <uuid>` to reuse one after a lost response. If a local mutation response is uncertain, HRA returns the generated key and the exact replay arguments without repeating the command payload. Put those arguments before any `--` delimiter when rerunning the otherwise unchanged command. session recover accepts only exact, kind-specific provider proof. session abandon never retries or deletes provider state and releases only the local recovery authority. Remote mutations require a current UUIDv7 when this option is supplied. With `--json`, stdout contains one versioned object; diagnostics stay on stderr.

`interaction show` lists each safe requested permission category and each exact question ID. Complete live command and permission authority is available only through the revision-bound protected `interaction inspect` path described above. A permission grant reads `{"permissions":["<requested-name>"]}` and a question response reads `{"answers":{"<question-id>":{"answers":["<answer>"]}}}` through protected input. The live Codex adapter rehydrates selected permission names to their exact private provider values immediately before the response write; those values never enter display, storage, logs, or sync.

Every admitted callback carries a local deadline anchored when Codex delivered it. HRA caps the pending interval at 30 minutes and honors a shorter valid provider interval, including an immediate zero interval. At the deadline it writes one provider-neutral timeout error through the same write-ahead ledger, never invents an answer or grant, and quarantines the provider generation if the write may have escaped. `interaction show` displays the safe local deadline; encrypted remote interaction metadata does not include it.

For a standard MCP form, interaction show returns the exact public field contract without defaults or answers. Accept reads one protected document shaped as `{"content":{...}}` from nonterminal stdin or a file descriptor. Decline and cancel accept no content. JSON mode never prompts, and validation failures identify the contract failure without echoing a submitted value.

Projection recovery uses the local-session selector rules. It requires `--acknowledge-gap` and a current UUIDv7, generated by the CLI when omitted. The same-key command is safe to replay after a lost response; a changed key cannot overtake unsettled recovery authority.

The beta does not expose destructive local profile or project deletion. `account logout` asks Codex app-server to remove that profile's provider login while HRA preserves its local session history.

## Authority boundaries

Codex app-server remains authoritative for provider login, transcripts, turns, tools, approvals, models, plugins, and usage. HRA owns isolated profiles, durable commands, process generations, local projections, optional encrypted sync, and recovery records.

Cloud service availability is not required for local login, local execution, local recovery, or reading local sessions. Multiple Codex accounts remain independent subscriptions. HRA does not pool quota or replay a limited turn under another account.

## Project

HRA is MIT licensed. Read the [security policy](https://github.com/hraness/hra/blob/main/SECURITY.md) before reporting a vulnerability, use [private vulnerability reporting](https://github.com/hraness/hra/security/advisories/new) for suspected security issues, and read the [contribution guide](https://github.com/hraness/hra/blob/main/CONTRIBUTING.md) before a large change.
