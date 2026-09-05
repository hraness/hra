# Adopt sessions from personal provider homes

HRA can discover recent Codex and Claude Code sessions in your personal provider homes and bring them into the local daemon. Adoption is opt-in for each provider. After provider-specific admission succeeds, the conversation is an ordinary HRA session with the same public session commands, autorespond policy, and approval authority as every other HRA session.

Discovery does not create a public or reduced-capability session tier. Candidates stay in private local state until HRA can claim them. The session list and normal session interface expose no separate source badge or mode.

## What discovery reads

The default personal provider homes are `~/.codex` and `~/.claude` for the current OS user.

- Codex discovery asks the pinned personal-home app-server for bounded session-list pages. It does not parse transcripts or a session index.
- Claude discovery reads only allowlisted scalar fields from the local live-session registry, accepts only records naming HRA's exact pinned Claude Code version, and never invokes Claude merely to discover sessions. The bounded registry snapshot must reach a proven end before a dead-process result can authorize admission; truncation, a read failure, or conflicting duplicate metadata leaves the candidate unknown and pending.
- Claude registry discovery never opens a registry key file or an advertised socket. Process liveness is inferred from the PID domain, PID, and the host's bounded process-start token.

During discovery, HRA requests only read operations from the provider binary or app-server, which may maintain its own home internals while servicing those requests. HRA does not directly modify or parse Codex home files. Its Claude fallback directly opens only allowlisted registry records read-only. Candidate records, liveness evidence, and controller provenance remain private local state and are not uploaded as candidates by cloud sync. Once adopted, the session's ordinary fields follow the same optional encrypted-sync rules as any other HRA session.

## Before you enable adoption

You need a signed-in HRA account to own the adopted session. The account selector records HRA ownership and routing. It does not copy or move credentials from the personal provider home.

Register every project root that HRA may adopt:

```text
hra project add --path /absolute/project/path --name project-name
```

The discovered provider project root must resolve to that exact registered directory. A candidate with no usable project root, or one whose root is not registered, stays private and pending rather than becoming a session.

Finish any active turn in the original provider controller. For Claude, exit the old process before adoption. For Codex, leave the conversation inactive long enough to cross the quiet-time threshold described below. HRA does not terminate a foreign provider process.

## Enable and inspect adoption

Enable adoption separately for each provider you want HRA to scan:

```text
hra session adoption enable personal --provider codex
hra session adoption enable personal --provider claude
```

Enabling a provider starts one bounded scan immediately. While the daemon is running, it repeats discovery for enabled providers. You can request another bounded scan and read aggregate status at any time:

```text
hra session discover
hra session discover --provider claude
hra session adoption status
hra session adoption status --provider codex
```

Use `--json` for versioned machine-readable output. Adoption status reports whether each provider is enabled, the owning account ID, and bounded `pending`, `adopted`, and `fenced` counts. It does not reveal private candidate identifiers.

Use `hra session list --account <account>` to list the account's ordinary HRA sessions. Once admission commits, a personal-home conversation appears there with the same public session fields as any other session. The account-filtered listing pages every locally known native and adopted session together in one source-neutral order before it discovers previously unknown provider rows. Pass its returned opaque `--cursor` unchanged when more than one page is available.

## Which sessions can be adopted

HRA admits only bounded, nonterminal observations from the last 15 minutes. Stale Codex rows and rows without a usable timestamp are not claimable history. Claude registry rows also need a recent timestamp and the exact pinned version.

Every candidate must also meet these conditions:

- Its provider is enabled and bound to one signed-in HRA account.
- Its reported project root matches a registered HRA project.
- No other HRA session or account already owns its provider thread.
- HRA can resume the exact provider thread and recheck its identity, project, and idle state.

Discovery and admission are separate checks. A candidate may remain pending until every provider-specific admission condition succeeds.

HRA permits only one active HRA binding for each provider thread. Provider APIs do not expose a global lock against every external controller, so adoption cannot prove that a terminal or another app will never resume the same conversation later. The private controller binding tells HRA where to route and release effects; it does not create a public session kind.

### Codex custody

Codex does not expose an exclusive handoff operation. HRA therefore uses an inactivity inference that is part of the opt-in policy. A row is treated as live while the provider reports an active state or active turn, and an idle row remains live for 10 minutes after its last update. An idle row more than 10 minutes old can be admitted while it is still inside the 15-minute discovery window. Missing or unusable timestamps remain unknown and pending.

For an eligible row, HRA resumes the exact thread through the pinned personal-home app-server with a policy-neutral resume. Before durable admission commits, that resume changes no provider turn policy; it establishes the exact thread, connection, and quiescent observation. After commit, every HRA-owned turn applies a fresh reviewed model, workspace permission profile, `on-request` approval policy, and `auto_review` reviewer immediately before provider dispatch, then records the effective response under the session's authority.

The pinned Codex protocol explicitly rejoins an already-running thread. Resume therefore proves identity and connection, but not exclusive ownership. A terminal or another app that resumes the thread after the inactivity check can become a concurrent controller. HRA cannot prevent that provider-level race. Choose one controller for subsequent writes, and do not resume the provider conversation elsewhere while HRA controls it. Disable adoption when you want to prevent future discovery and adoption.

### Claude custody

Claude adoption uses bounded process evidence because resuming a conversation starts a new process with stdin and approval authority. HRA treats a process as live only while its PID domain, PID, and captured host process-start token all match. A previously captured PID absent from the process table, or a captured PID whose start token now differs, is treated as not live. A registry record missing an exact PID identity, an inaccessible process table, an unsupported PID domain, or otherwise incomplete evidence remains unknown. On supported hosts the token comes from `ps lstart`, whose one-second wall-clock granularity cannot distinguish the extremely narrow case of PID reuse with the same rendered start time. Such an alias fails toward retaining custody and refusing handoff, not toward adopting an ambiguously live conversation.

HRA resumes a Claude candidate only after the old process probe reports not live. Live and unknown candidates stay pending. HRA privately retains a bounded candidate's PID-domain, PID, and source-process start token so that, if its registry row disappears after the first scan, a later scan can re-probe the same tuple rather than treating disappearance as proof of exit. The retained identity is useful only for that exact candidate revision and is never exposed in the public session shape. The pinned runtime starts `--resume` for the exact session ID and requires the resulting initialization event to confirm that same ID before adoption commits.

This prevents HRA from attaching to the exact old Claude process. It is a bounded liveness inference, not a provider-wide lease: another user process can still start a separate resume after HRA's check. Choose one controller for subsequent writes and avoid resuming the same Claude conversation elsewhere while HRA controls it.

## After adoption

An admitted session uses the ordinary HRA session surface. You can send, queue, steer, stop, rename, inspect, watch, schedule work, and apply the normal preset and autorespond controls. The same default `auto:all` approval mode and per-session autorespond overrides apply. Provider approval callbacks arrive on HRA's resumed connection or process, and HRA answers them with the same authority and evidence rules used for every HRA session.

HRA cannot answer an approval that was delivered only to a prior controller, and it does not backfill a complete local event history from before adoption. Existing provider history remains in the provider home and can appear through ordinary bounded provider reads.

One pinned Codex protocol limitation is narrower than the public session surface: `thread/resume` can replace approval, reviewer, model, and workspace policy, but it cannot add a thread-creation-only dynamic tool to a conversation that never had it. CLI and app scheduling still work, and HRA enables its automation handler if the resumed thread already knows that tool, but the model in an arbitrary pre-existing Codex thread may be unable to originate an automation change itself.

## Account changes and recovery

Session origin does not change account authority or recovery behavior. HRA binds each controlled session to the exact provider account identity it admitted and rechecks that identity around provider effects. If the provider signs out, exposes a replacement account, or no longer exposes a provable identity, HRA first marks every affected nonterminal session `recovery_required`. It cancels effects that have not started, preserves in-flight effects as ambiguous or unknown, pauses scheduled work, and releases the exact native and personal-home controllers held by the prior authority. Account and session status keep that recovery visible, and daemon restart continues any incomplete release.

No origin-specific command is required when you explicitly log in, log out, or replace the provider account. Those changes use the same fail-closed revocation path for HRA-created and adopted sessions, which can make them temporarily unavailable while prior controller authority is released. Establish the intended provider identity and resolve the reported recovery before sending another mutation.

After HRA completes a personal-home Codex account revocation, it deliberately refuses to relaunch that same account generation. Adoption status reports `restartRequired: true`, and an enable attempt returns `RECOVERY_REQUIRED` with restart guidance. Restart the daemon to create a fresh runtime generation, verify the intended provider identity, and then enable Codex adoption again. This fence never permits an ordinary account read to silently recreate the released controller.

## Disable future adoption

```text
hra session adoption disable --provider codex
hra session adoption disable --provider claude
```

Disabling a provider stops future discovery and adoption for that provider. It does not change the capabilities or lifecycle of sessions HRA already controls.

## If a candidate stays pending

Check these conditions:

- The provider session was updated within the last 15 minutes and is not terminal.
- The session reports the exact root of a registered HRA project.
- Codex has been idle for more than 10 minutes, or the prior Claude process probe reports not live.
- Claude Code matches HRA's pinned version, and the old exact process identity is no longer live.
- The selected HRA account is still signed in and the daemon is running.

Run `hra session discover --provider <codex|claude>` after correcting the condition. If enabling adoption reports discovery state `unavailable`, the daemon could not complete the bounded provider read or admission check. The candidate remains private and is not adopted speculatively.
