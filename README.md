# HRA
[![npm version](https://img.shields.io/npm/v/%40hraness%2Fhra)](https://www.npmjs.com/package/@hraness/hra) [![provenance: sigstore](https://img.shields.io/badge/provenance-sigstore-2e7d32)](https://www.npmjs.com/package/@hraness/hra#provenance) [![CI](https://img.shields.io/github/actions/workflow/status/hraness/hra/ci.yml?branch=main&label=CI)](https://github.com/hraness/hra/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/npm/l/%40hraness%2Fhra)](https://github.com/hraness/hra/blob/main/LICENSE) [![Bun 1.3.14](https://img.shields.io/badge/Bun-1.3.14-14151a)](https://bun.sh) [![runtime: Codex 0.153.2](https://img.shields.io/badge/runtime-Codex%200.153.2-0b5fa5)](https://www.npmjs.com/package/@openai/codex/v/0.153.2) [![runtime: Claude Code 2.1.260](https://img.shields.io/badge/runtime-Claude%20Code%202.1.260-6f42c1)](https://github.com/hraness/hra/blob/main/docs/providers/claude.md)\
HRA runs Codex and Claude Code sessions side by side, keeps them alive in a local daemon, and gives humans and AI agents the same commands to drive them.

Status: public beta. Local CLI v0.7.0 is a release candidate, while v0.6.3 is the fully admitted public artifact. Codex runs on macOS and Linux, Claude Code on Linux; hosted sync is live as an open beta. Current daemon and hosted command-writer rollout remains blocked on capacity.

```sh
test "$(unset BUN_OPTIONS NODE_OPTIONS LD_AUDIT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_IMAGE_SUFFIX DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_ROOT_PATH DYLD_VERSIONED_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH && curl -fsSL --connect-timeout 10 --max-time 60 --max-filesize 524288 --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/hraness/hra/v0.7.0/src/install-preflight-runtime.ts | command bun --no-env-file --config=/dev/null -e 'const n=["BUN_OPTIONS","NODE_OPTIONS","LD_AUDIT","LD_LIBRARY_PATH","LD_ORIGIN_PATH","LD_PRELOAD","DYLD_FALLBACK_FRAMEWORK_PATH","DYLD_FALLBACK_LIBRARY_PATH","DYLD_FRAMEWORK_PATH","DYLD_IMAGE_SUFFIX","DYLD_INSERT_LIBRARIES","DYLD_LIBRARY_PATH","DYLD_ROOT_PATH","DYLD_VERSIONED_FRAMEWORK_PATH","DYLD_VERSIONED_LIBRARY_PATH"],x=process.execArgv;const c=x.filter(v=>v==="-c"||v.startsWith("--config"));if(n.some(k=>process.env[k]!==undefined)||x.filter(v=>v==="--no-env-file").length!==1||c.length!==1||c[0]!=="--config=/dev/null"||x.some(v=>v.startsWith("-r")||v==="--preload"||v.startsWith("--preload=")||v==="--require"||v.startsWith("--require=")||v==="--import"||v.startsWith("--import=")||v==="--env-file"||v.startsWith("--env-file=")))throw new Error("The tagged HRA preflight requires a neutral Bun stage zero.");const[a,h]=process.argv.slice(1);const r=Bun.stdin.stream().getReader(),q=[];let z=0;try{for(;;){const o=await r.read();if(o.done)break;z+=o.value.byteLength;if(z>524288)throw new Error("The tagged HRA preflight exceeds its byte limit.");q.push(o.value)}}finally{r.releaseLock()}const b=new Uint8Array(z);let p=0;for(const v of q){b.set(v,p);p+=v.byteLength}const d=new Bun.CryptoHasher("sha256").update(b).digest("hex");if(d!==h)throw new Error("The tagged HRA preflight digest is invalid.");const j=new Bun.Transpiler({loader:"ts",target:"bun"}).transformSync(b);const u=URL.createObjectURL(new Blob([j],{type:"text/javascript"}));try{const m=await import(u);await m.installHraRelease(a);process.stdout.write(`${m.HRA_INSTALL_SUCCESS}\n`);}finally{URL.revokeObjectURL(u)}' -- https://github.com/hraness/hra/releases/download/v0.7.0/hraness-hra-0.7.0.tgz b71ccada062fcda657cd373818e3fe109acec9797b418e10f0c24b118123b0ba)" = hra-install-safe
```

```sh
hra doctor --offline
```

> Current daemon and hosted command-writer rollout remains blocked on capacity. Do not initialize, start, or autostart the admitted v0.6.3 daemon or candidate v0.7.0 daemon until the hosted operator records protected two-pass zero-debt capacity evidence and its exact .activated readback receipt. Artifact availability, candidate readiness, and the live sync service do not clear this gate. After activation, complete the update runbook's daemon and target marker-2 proofs before globally enabling hosted writers.

After the rollout prerequisite is satisfied, initialize:

```sh
hra init --yes
```

## One terminal for every Codex and Claude Code session

HRA keeps sessions alive behind a local daemon, isolates each account, and lets you or your agent direct any of them from a shell or JSON. Sync between machines is optional and encrypted.

Local v0.7.0 release candidate · v0.6.3 artifacts admitted · current daemon and hosted command-writer rollout blocked on capacity · Codex on macOS and Linux · Claude Code on Linux · hosted sync live (open beta)

### One request, one account, one session.

1. **Start:** `hra session start personal --provider codex --json`. Create a Sol Ultra Codex session under the account profile you name.
2. **Inspect:** `hra session status <session-id> --json`. Read the session and the cursor where its event stream continues.
3. **Switch:** `hra session switch <session-id> --provider claude --preset fable-max`. Move the next turns to your signed-in Claude Code profile. The bounded retained HRA conversation record remains available, with any retention gap stated explicitly.
4. **Direct:** `hra session send <session-id> -- "Review this project."`. Send the next request to that session and provider.

> **Local v0.7.0 candidate; v0.6.3 artifacts admitted; hosted sync live as an open beta.** Use the exact install command below only after immutable GitHub and npm release admission for `v0.7.0`. The [v0.6.3 artifacts](https://github.com/hraness/hra/releases/tag/v0.6.3) passed immutable GitHub and npm release admission. The website and optional hosted sync are live; candidate readiness and prior artifact admission do not authorize current-daemon startup or hosted command writers.

> **Current daemon rollout blocked.** Current daemon and hosted command-writer rollout remains blocked on capacity. Do not initialize, start, or autostart the admitted v0.6.3 daemon or candidate v0.7.0 daemon until the hosted operator records protected two-pass zero-debt capacity evidence and its exact .activated readback receipt. Artifact availability, candidate readiness, and the live sync service do not clear this gate. After activation, complete the update runbook's daemon and target marker-2 proofs before globally enabling hosted writers.

HRA is one Bun CLI plus a local daemon. It isolates Codex and Claude Code profiles, gives both providers one compact session interface, and optionally syncs encrypted provider-neutral projections and commands across your enrolled machines.

HRA is short for harness: the control plane that keeps Codex and Claude Code sessions working together, and [hraness.com](https://hraness.com/) explains the parent brand. The Hraness organization maintains HRA and publishes it under the MIT license.

[GitHub](https://github.com/hraness/hra) · [Documentation](https://github.com/hraness/hra#command-reference) · [Security](https://github.com/hraness/hra/blob/main/SECURITY.md) · [Privacy](https://github.com/hraness/hra/blob/main/PRIVACY.md)

## Install and update

HRA requires Bun 1.3.14 plus curl with HTTPS and TLS 1.2 support. The CLI and local daemon support macOS and Linux. Codex effects run on both platforms; Claude Code effects run on Linux only. HRA refuses new Claude Code effects on macOS pending authenticated isolated-Keychain and detached-read acceptance. Supported ChatGPT desktop account switching is macOS-only. Native protected-input control loads only when a terminal prompt needs it and supports the standard macOS, glibc, and x64 or arm64 musl library names. After this candidate passes immutable release admission, install its reviewed tag, then verify the binary before initialization:

```text
bun --version
test "$(unset BUN_OPTIONS NODE_OPTIONS LD_AUDIT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_IMAGE_SUFFIX DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_ROOT_PATH DYLD_VERSIONED_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH && curl -fsSL --connect-timeout 10 --max-time 60 --max-filesize 524288 --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/hraness/hra/v0.7.0/src/install-preflight-runtime.ts | command bun --no-env-file --config=/dev/null -e 'const n=["BUN_OPTIONS","NODE_OPTIONS","LD_AUDIT","LD_LIBRARY_PATH","LD_ORIGIN_PATH","LD_PRELOAD","DYLD_FALLBACK_FRAMEWORK_PATH","DYLD_FALLBACK_LIBRARY_PATH","DYLD_FRAMEWORK_PATH","DYLD_IMAGE_SUFFIX","DYLD_INSERT_LIBRARIES","DYLD_LIBRARY_PATH","DYLD_ROOT_PATH","DYLD_VERSIONED_FRAMEWORK_PATH","DYLD_VERSIONED_LIBRARY_PATH"],x=process.execArgv;const c=x.filter(v=>v==="-c"||v.startsWith("--config"));if(n.some(k=>process.env[k]!==undefined)||x.filter(v=>v==="--no-env-file").length!==1||c.length!==1||c[0]!=="--config=/dev/null"||x.some(v=>v.startsWith("-r")||v==="--preload"||v.startsWith("--preload=")||v==="--require"||v.startsWith("--require=")||v==="--import"||v.startsWith("--import=")||v==="--env-file"||v.startsWith("--env-file=")))throw new Error("The tagged HRA preflight requires a neutral Bun stage zero.");const[a,h]=process.argv.slice(1);const r=Bun.stdin.stream().getReader(),q=[];let z=0;try{for(;;){const o=await r.read();if(o.done)break;z+=o.value.byteLength;if(z>524288)throw new Error("The tagged HRA preflight exceeds its byte limit.");q.push(o.value)}}finally{r.releaseLock()}const b=new Uint8Array(z);let p=0;for(const v of q){b.set(v,p);p+=v.byteLength}const d=new Bun.CryptoHasher("sha256").update(b).digest("hex");if(d!==h)throw new Error("The tagged HRA preflight digest is invalid.");const j=new Bun.Transpiler({loader:"ts",target:"bun"}).transformSync(b);const u=URL.createObjectURL(new Blob([j],{type:"text/javascript"}));try{const m=await import(u);await m.installHraRelease(a);process.stdout.write(`${m.HRA_INSTALL_SUCCESS}\n`);}finally{URL.revokeObjectURL(u)}' -- https://github.com/hraness/hra/releases/download/v0.7.0/hraness-hra-0.7.0.tgz b71ccada062fcda657cd373818e3fe109acec9797b418e10f0c24b118123b0ba)" = hra-install-safe
hra --version
hra doctor --offline
```

After artifact admission, the single install command removes ambient Bun, Node, and native-library injection variables before either download or Bun startup, disables Bun dotenv loading, and selects /dev/null as the only Bun configuration. Curl and the loader independently cap the streamed preflight at 512 KiB, and the loader refuses an overrun before transpilation or installation. It then verifies and executes the exact v0.7.0 preflight from HRA's protected source tag and passes it the exact release archive URL. The preflight requires GitHub repository ID 1343008607, a published immutable v0.7.0 release, and one uploaded archive whose byte length and SHA-256 match GitHub's immutable release metadata. It creates a fresh random private staging root, downloads the archive into a private file there, and gives Bun only a verified in-memory snapshot of those exact bytes. The reviewed normalizer verifies the private archive again, derives its bounded package-file manifest, and compares every extracted HRA package path and SHA-256 while measuring the completion receipt. Local archives and official archives use separate full-digest version namespaces, so a local package cannot populate or replace the official cache entry. HRA then verifies the tagged preflight and normalizer, exact package identity, zero-lifecycle manifest, CLI SHA-256, and complete staged tree under protected descriptor and ACL custody. Bun 1.3.14 resolves the package's exact dependency versions from the configured package registry trust boundary with lifecycle scripts disabled; the release archive does not claim to contain that dependency closure. The detached staging worker and its Bun package-install child repeat the runtime neutralization while retaining the configured registry, proxy, and certificate trust inputs needed for dependency resolution. The prior verified command remains active throughout staging. Publication atomically replaces only the $BUN_INSTALL/bin/hra symlink after every check succeeds and fsyncs its directory. If installation is interrupted, the next invocation of that exact release's installer recovers or removes only the proven private stage; another release's installer refuses the durable intent. The invoking shell, PATH-selected pinned Bun binary, configured package registry and transport trust, operating system, and same-UID account remain trust boundaries. Existing trustedDependencies remain unchanged.

### Update runbook

Use this sequence to replace an installed release. Resolve every uncertain local mutation that depends on old alias or prepared authority before starting the current daemon, and preserve remote-command evidence for the fail-closed reconciliation below. Replace the tagged preflight URL, release archive URL, expected preflight digest, and expected version together with one exact reviewed immutable tag. Never install a moving branch on a release machine, and never run an older daemon against this state root after the current daemon has started.

1. Settle any durable installer intent left by an interrupted installation. An installer refuses `$BUN_INSTALL/install/hra/install-intent.json` when the intent is invalid or belongs to another release. Do not edit or delete that file or its staging or version directories. Rerun the exact immutable install command from the originating release's trusted README or release notes and require the exact `hra-install-safe` success output. If that installer refuses the intent, stop installation and use bounded read-only diagnosis while preserving the intent and its directories; after exact recovery succeeds, restart this runbook with the current release. Establish the originating tag independently from trusted release evidence; never execute a URL or command copied only from the intent. An uncertain tag blocks execution, not diagnosis. Ask the owner only when the evidence cannot resolve a required decision or authority is missing. This recovers only local installer state. It is not authorization to retry, rerun, or mutate that release's GitHub Actions workflow, tag, GitHub Release, or npm publication.

2. Resolve keyed local mutations under the installed release. For a Codex High or Ultra `session start`, or a source-sensitive provider switch that explicitly or implicitly selects either alias, replay the exact idempotency key using the originating release's own syntax and source evidence. Resolve an affected Work mutation by replaying its exact request document. A v42 attachment-bearing send or steer should likewise be replayed under v42 before updating whenever that release remains usable; retain the exact original message, attachment path and basename, and explicit key if migration has already occurred and the narrow v43 bridge below is required. Continue only when exact replay under the originating release, or that release's documented kind-specific recovery, reaches a terminal settlement. Otherwise the update remains blocked. If that release has no explicit source-contract flag, use only its exact syntax; do not invent an unsupported option or infer an old alias meaning from the new release.

3. Resolve any uncertain `session preset` under the installed release. This command has no idempotency key, so repeat it if necessary and inspect the session before updating.

4. Block the update on any remaining prepared or indeterminate local mutation. HRA exposes no general command to cancel a prepared session start or provider switch, and `session abandon` applies only to an existing recovery-required session. Retain the originating release and state root until exact replay or its documented recovery reaches a terminal settlement. Do not generate a fresh key or edit SQLite as a workaround.

5. Reconcile every uncertain CLI session-command enqueue by repeating the exact remote request with its exact idempotency key. Let HRA's durable local outbox reconcile the response, retain every returned session-command ID, and inspect each one with `hra remote command <uuidv7>`. For a browser or device command, retain the current tab's returned command handle and public ID, then inspect it through the app or the corresponding hosted query. The app does not expose its internal idempotency key and must not synthesize a resend. Never edit or delete the local command journal, local outbox, tab state, or hosted row to force progress.

6. Stop the daemon and prove that it released authority:

   ```text
   hra daemon stop --json
   hra daemon status --json
   ```

   Require the stop command itself to exit zero; its recovery path is the authority-release proof. Treat a status response containing `data.running: false` only as a secondary no-listener confirmation. Status alone does not prove authority release. Stop on any stop or recovery error.

7. Only after v0.7.0 completes immutable GitHub and npm release admission, install that exact release, then verify the installed version and offline health:

   ```text
   test "$(unset BUN_OPTIONS NODE_OPTIONS LD_AUDIT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_IMAGE_SUFFIX DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_ROOT_PATH DYLD_VERSIONED_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH && curl -fsSL --connect-timeout 10 --max-time 60 --max-filesize 524288 --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/hraness/hra/v0.7.0/src/install-preflight-runtime.ts | command bun --no-env-file --config=/dev/null -e 'const n=["BUN_OPTIONS","NODE_OPTIONS","LD_AUDIT","LD_LIBRARY_PATH","LD_ORIGIN_PATH","LD_PRELOAD","DYLD_FALLBACK_FRAMEWORK_PATH","DYLD_FALLBACK_LIBRARY_PATH","DYLD_FRAMEWORK_PATH","DYLD_IMAGE_SUFFIX","DYLD_INSERT_LIBRARIES","DYLD_LIBRARY_PATH","DYLD_ROOT_PATH","DYLD_VERSIONED_FRAMEWORK_PATH","DYLD_VERSIONED_LIBRARY_PATH"],x=process.execArgv;const c=x.filter(v=>v==="-c"||v.startsWith("--config"));if(n.some(k=>process.env[k]!==undefined)||x.filter(v=>v==="--no-env-file").length!==1||c.length!==1||c[0]!=="--config=/dev/null"||x.some(v=>v.startsWith("-r")||v==="--preload"||v.startsWith("--preload=")||v==="--require"||v.startsWith("--require=")||v==="--import"||v.startsWith("--import=")||v==="--env-file"||v.startsWith("--env-file=")))throw new Error("The tagged HRA preflight requires a neutral Bun stage zero.");const[a,h]=process.argv.slice(1);const r=Bun.stdin.stream().getReader(),q=[];let z=0;try{for(;;){const o=await r.read();if(o.done)break;z+=o.value.byteLength;if(z>524288)throw new Error("The tagged HRA preflight exceeds its byte limit.");q.push(o.value)}}finally{r.releaseLock()}const b=new Uint8Array(z);let p=0;for(const v of q){b.set(v,p);p+=v.byteLength}const d=new Bun.CryptoHasher("sha256").update(b).digest("hex");if(d!==h)throw new Error("The tagged HRA preflight digest is invalid.");const j=new Bun.Transpiler({loader:"ts",target:"bun"}).transformSync(b);const u=URL.createObjectURL(new Blob([j],{type:"text/javascript"}));try{const m=await import(u);await m.installHraRelease(a);process.stdout.write(`${m.HRA_INSTALL_SUCCESS}\n`);}finally{URL.revokeObjectURL(u)}' -- https://github.com/hraness/hra/releases/download/v0.7.0/hraness-hra-0.7.0.tgz b71ccada062fcda657cd373818e3fe109acec9797b418e10f0c24b118123b0ba)" = hra-install-safe
   hra --version
   hra doctor --offline
   ```

   Require the exact expected version. Before the first current-daemon start, doctor must either succeed or report only the exact pending state-schema migration that names the old and current schema versions. Any other diagnostic stops the update.

8. Before starting any current daemon, require the hosted operator to deploy the additive candidate from this release's exact reviewed source, then run the source- and runtime-bound command-capacity status and repair workflow in `docs/hosted-sync.md`. Accept only its protected two-pass zero-debt capacity evidence together with the exact .activated receipt produced after hosted activation and readback for that candidate and numeric target. The capacity evidence alone is not readiness. The hosted activation tuple opens the exact-runtime gate; the later local .activated publication proves the readback and is required before declaring writers ready, but does not itself open that gate. A hard-full legacy owner, partial capacity set, unreserved command debt, unsafe cleanup shape, interrupted intent, candidate swap, concurrent debt, missing activation, or failed readback blocks the update. The Vercel app may auto-deploy earlier, but that UI is not command readiness or effect authority and its commands should receive expected pre-insertion refusals while the runtime gate is closed.

9. Start the current daemon. This is the no-downgrade boundary: after this command begins, never launch an older daemon against the same state root. Prove post-migration health before syncing, then inspect every retained CLI session-command ID:

   ```text
   hra daemon start
   hra doctor --offline
   hra sync now --json
   hra sync status
   hra remote command <uuidv7>
   ```

   Require the post-start doctor command to succeed before sync. If migration retained a v42 send or steer that stopped after preparation but before its attachment manifest or provider effect, replay it now with the same command kind, session, message, original attachment path and basename, and explicit idempotency key. The current CLI admits an earlier-policy-only basename only on this keyed local replay, and the daemon requires the original durable request digest before resolving the blob or contacting a provider. Any missing or changed field fails without a new mutation; fresh sends, steers, queued messages, and hosted payloads remain on the current name rule. For every intended target, require the sync-now response to contain `data.online: true` and `data.errorCount: 0`, and `data.commandRequestVersion: 2`; a pending device identity or failed registry publication leaves the last field null, and the command exits zero even when its bounded diagnostics report a registry-publication failure. There is no per-target writer switch. Finish all intended target proofs before deploying marker-emitting writer clients globally, or accept and monitor the expected pre-insertion refusals on ungated or mismatched targets. Old clients and targets whose markers are both absent remain compatible. Sync status reports projection recovery, not the command outbox. Use retained CLI session-command IDs for remote-command inspection; inspect browser and device commands through the app or corresponding hosted query.

10. Classify legacy remote commitments from both the local journal and hosted row before retrying. The current daemon never executes a legacy request commitment. An already-hosted terminal row takes precedence: it confirms the hosted result and permits local retirement without replaying a local outcome. Otherwise, if the hosted row remains nonterminal and either side records `effect_started`, close it result-less as `ambiguous`. A legacy local terminal outcome over any hosted nonterminal row is unauthenticated evidence: discard that outcome and close result-less as `LOCAL_EFFECT_RECOVERY_REQUIRED` ambiguous. A fresh or local-prepared legacy request over hosted `pending` or `prepared` row closes as `failed` with `LEGACY_REQUEST_COMMITMENT_BEFORE_EFFECT`. Retry only a failed-before-effect request, only after its initiating client is also current, and use a fresh idempotency key. Retain the new command ID. Never automatically retry an ambiguous command. Each daemon privately publishes its command-request version before processing commands. A fresh request is inserted only when its marker exactly matches the target's last stored registry marker and the hosted runtime's capacity activation tuple exactly matches its compiled release attestation. A marker or activation mismatch is rejected before the command, quota charge, or security event is written. A stale matching target marker can exist during an upgrade or downgrade window, but a candidate redeploy invalidates the hosted activation, and the executor checks stop a mismatched binary before prepare or provider effect while recovery paths classify retained rows conservatively. Exact same-key replay remains available across a later target or runtime change, but changing versions under one key conflicts. A registry-publication failure skips both command queues for that cycle, and every marker-2 command also requires current target and hosted activation markers before a new prepare or effect start. The hosted tuple, not the local receipt publication, opens the runtime gate. Accept the protected capacity evidence and its .activated readback receipt from the prerequisite above before declaring writers ready. Require one `hra sync now --json` result with `data.online: true` and `data.errorCount: 0`, and `data.commandRequestVersion: 2`, before treating marker-emitting writers as globally available. The Vercel app can auto-deploy from main earlier; that UI is not readiness, and its commands should receive expected pre-insertion refusals until capacity activation and target-marker proof exist. No all-daemons pause or account-wide legacy drain is required.

> **v0.5 upgrade quarantine.** The first daemon start after a v0.5-to-v0.6 upgrade migrates local state but never infers provider-account authority that v0.5 did not record immutably. Every affected nonterminal session enters recovery_required: pending or prepared effects are cancelled, begun effects remain uncertain, scheduled work pauses, pending interactions expire while begun responses become resolution-unknown, and associated Work execution is retired or fenced. Provider threads and local records are not deleted. This is not a generic automatic-recovery state. Inspect the session first; use `hra session abandon <session>` only when you accept terminalizing HRA's local session with provider state still unknown.

### Optional full local-data removal

Full local-data removal is a separate destructive operation. While HRA remains installed, complete `hra auth delete --acknowledge-erasure` if `hra auth status` says you are signed in, then wait for `hra auth status` to report terminal deletion. Run `hra account list`, then run `hra account logout <profile>` for every Codex profile. HRA does not sign Claude Code out; use Claude Code's own authentication flow inside every isolated `CLAUDE_CONFIG_DIR` whose credential should be removed. Stop the daemon and require `hra daemon stop --json` itself to exit zero as the authority-release proof. A successful `hra daemon status --json` result whose `data.running` is `false` is only an optional no-listener confirmation before touching local data.

```text
hra auth delete --acknowledge-erasure
hra auth status
hra account list
hra account logout <profile>
hra daemon stop --json
hra daemon status --json
```

> **Permanent local-data loss.** HRA deliberately has no recursive local-delete command. The exact state directory is `$HOME/Library/Application Support/HRA Control Plane v1` on macOS and `$HOME/.local/state/hra-control-plane-v1` on Linux. After every prerequisite above, a human who explicitly accepts permanent loss of all local provider profiles, Codex credential stores, Claude Code configuration directories, sessions, ledgers, encryption keys, device credentials, and recovery evidence may move only the exact platform directory to Trash. Claude Code may also own credentials outside that directory, including provider-managed system credential storage; sign out through Claude Code before deletion. Do not move or remove the state directory's parent. Inspect the trashed directory before emptying Trash.

An agent must resolve the canonical exact state-directory path, present that path and the permanent-loss consequences to the user, and obtain explicit destructive approval before moving or removing it. An install, update, or daemon-stop request does not authorize local-data removal.

## First account

> **Conditional walkthrough.** Current daemon and hosted command-writer rollout remains blocked on capacity. Do not initialize, start, or autostart the admitted v0.6.3 daemon or candidate v0.7.0 daemon until the hosted operator records protected two-pass zero-debt capacity evidence and its exact .activated readback receipt. Artifact availability, candidate readiness, and the live sync service do not clear this gate. After activation, complete the update runbook's daemon and target marker-2 proofs before globally enabling hosted writers.

```text
hra account add personal
hra account login personal --provider codex --device-code
hra account usage personal --refresh
hra account usage-history personal --limit 50 --json
```

Account login is always a dedicated one-shot invocation, including while the persistent shell is running. For Codex, use `hra account login personal --provider codex --device-code` in a foreground TTY for app-server's device-code path. That terminal displays the code and verification URL directly. An opted-in registered machine can also receive a versioned web request that always selects device-code mode; HRA accepts only the pinned Codex device URL and a separate closed code, encrypts them to the account key, and lets only the requesting browser read the handoff once before its five-minute hosted expiry. HRA keeps the resulting provider state inside that profile's isolated `CODEX_HOME` without copying `auth.json`.

On Linux, `hra account login personal --provider claude` launches a realpath-resolved Claude Code executable only after its exact self-reported version matches HRA's pin, in the foreground inside that profile's isolated `CLAUDE_CONFIG_DIR`. Claude owns its prompts and browser handoff. HRA gives it the terminal, joins the exact child, and reports only whether Claude says it is signed in; HRA never opens or copies a Claude credential. Claude exposes no HRA device-code, handoff-file, or web-linking protocol. New Claude effects are refused on macOS pending authenticated isolated-Keychain and detached-read acceptance.

For a Codex login, JSON and noninteractive callers must create an empty mode-0600 file under a canonical current-user-owned mode-0700 directory, then pass its absolute canonical path:

```text
hra account login personal --device-code --handoff-file /absolute/private/login.json --json
```

HRA opens and holds the parent and file, resolves the account selector to one exact local account ID, and dispatches login only for that authority. It validates the returned account, state, cancellation command, URL, and device-code shape, writes one versioned login document through the held descriptor, verifies it with fsync and readback, and closes both descriptors before returning only the path and cleanup disposition on stdout. The caller reads the file through its protected boundary and removes it after login. A same-key replay never claims or rewrites a handoff. While login is pending it reports that one-time instructions are unavailable; after completion or cancellation it reports the terminal account state.

If the first pending-login handoff is lost or the daemon restarts before completion, `hra account show personal --provider codex` reports the pending attempt. Then run `hra account login-cancel personal --provider codex`. A caller that retained the idempotency key may retry it without redispatching. A still-pending local replay cannot recover the one-time code or URL; a completed or canceled replay returns terminal signed-in or signed-out evidence instead of stale pending state. HRA cancels only that profile's exact current-generation provider login before allowing a fresh login. Verification URLs and user codes never enter local durable HRA state, logs, or ordinary command output. A protected handoff file may retain them for its local caller; the web path instead retains only an account-key-encrypted, one-read hosted result until consumption or five-minute expiry.

If a Claude foreground parent or daemon fails after launch, `hra account show personal --provider claude` retains the one-child fence even if Claude reports signed in. After confirming that original child has exited, use the exact attempt, generation, and idempotency key in the reported acknowledged `hra account login-cancel` command to release only the local fence. That recovery does not stop Claude or read, change, or delete a credential.

`hra account list --provider codex` or `hra account list --provider claude --json` reads cached provider order, default marker, readiness and observation times. It does not refresh providers or change account selection. Unknown observation times stay unknown; cached readiness is not current sign-in proof or quota freshness. The read verifies at most 10,000 live profiles and returns at most 10,000 accounts within a separate 3 MiB JSON limit, refusing oversized or inconsistent results without truncation. Unqualified `hra account list` keeps the existing profile listing.

`hra account usage` is Codex-only and keeps the latest snapshot and 1-, 5-, and 15-minute observed token velocity. `hra account usage-history <profile>` reads the retained 24-hour local ledger in durable source order. Use UTC RFC3339 `--from` and `--through` bounds plus the returned opaque cursor for later pages; a cursor freezes that account and range and expires after five minutes. History rows contain only derived token observations or closed poll-failure codes; raw provider payloads are never returned.

`hra usage auto status [codex|claude]` reads local automatic-policy configuration and its revision. Without a provider, `on|off` changes the inherited default, not a global kill switch. A provider's explicit `on` override remains enabled when that default is off; `inherit <codex|claude>` restores inheritance. Every change requires `--revision <n>` from status and a caller-owned `--idempotency-key <uuid>`. After a lost response, replay the exact command with the same key and revision. Its saved receipt is not the current configuration; read status again for that. These controls do not refresh providers, move accounts or sessions, or enable unavailable runtime capabilities. Devin has no automatic usage policy.

When effective Codex automatic policy is enabled, HRA automatically spends one available earned Codex rate-limit reset when a fresh read shows the exact seven-day Codex window at 99 percent used or higher. It records a private idempotency key before dispatch, retries only that key after an uncertain response, and rereads limits after every closed outcome. Disabling suppresses new automatic reset dispatches, including retries, while retaining uncertain attempts under their original keys. A later disable does not cancel an already admitted operation or skip settlement and rereading after a closed outcome. A successful redemption is latched to that weekly window, so a stale usage snapshot cannot spend another credit. Rate-limit notifications wake a coalesced authoritative read; the staggered 50-to-70-second poll remains the fallback. `hra account usage` reports the most recent local reset attempt with its source weekly-window boundary and suppresses a prior identity's snapshot after an account change. Credit IDs, descriptions, private keys, and account fingerprints never enter that reset status or its cloud projection.

Automatic account movement is not exposed yet. The adopted provider-usage boundary permits only a managed Codex session to follow a durable account decision after reset handling and fresh exact source and target reads. Explicit sessions and work tasks stay pinned to the account you selected. Claude and Devin accounts never rotate automatically, and HRA never replays a failed or ambiguous turn under another account.

HRA cloud identity is separate from every Codex or Claude Code account. Use the email-code flow below only after a hosted or self-managed Convex deployment has been configured.

## First session

> **Conditional walkthrough.** Current daemon and hosted command-writer rollout remains blocked on capacity. Do not initialize, start, or autostart the admitted v0.6.3 daemon or candidate v0.7.0 daemon until the hosted operator records protected two-pass zero-debt capacity evidence and its exact .activated readback receipt. Artifact availability, candidate readiness, and the live sync service do not clear this gate. After activation, complete the update runbook's daemon and target marker-2 proofs before globally enabling hosted writers.

Only after the rollout prerequisite is satisfied, complete initialization and the first provider login before this walkthrough. Account login remains a dedicated one-shot command, and the session-start command returns the new session ID.

### Human terminal

Create an idle session, open the persistent shell, select the account and exact returned session ID, then type a request as an ordinary line. HRA sends that line to the selected session and shows safe live updates. `/exit` leaves the daemon running.

```text
hra session start personal --provider codex
hra
/account personal
/session <session-id>
Review this project and summarize its current state.
```

### Agent caller

Read `data.session.id` from the start response. Before sending, call status and read `data.eventStream.cursor` from its version-2 result. Start watch from that exact cursor so the atomic local snapshot and subsequent event stream are contiguous. Keep watch as a long-running subprocess, consume its two output streams independently, and use the exact ID instead of a mutable title in automation.

```text
hra session start personal --provider codex --json
hra session status <session-id> --json
hra session send <session-id> -- "Review this project and summarize its current state."
hra session watch <session-id> --cursor <status-cursor> --jsonl
hra session interactions <session-id> --pending --json
```

If the event stream reports a blocking interaction, read its exact ID and revision, inspect the live authority through the protected path, and resolve only the interaction kind you received. Keep following while a separate one-shot invocation handles the approval, question, permission grant, or supported MCP form. The protected interaction commands and input documents are defined below.

Devin support has been removed because its supported CLI integration cannot provide verified remaining account quota and reset times. Existing Devin history is read-only and provider-owned credentials are preserved. [Retired-provider compatibility and local login-fence cleanup](https://github.com/hraness/hra/blob/main/docs/providers/devin.md) remain documented; no new Devin login or session can start.

### Claude Code and provider switching

Start directly with Claude Code by selecting its provider and reviewed preset, or move an idle session between providers. A switch seeds a fresh provider-native runtime from the latest retained tail of HRA's provider-neutral conversation record; it does not move a provider-native thread. From the point the v0.6 daemon begins recording a session, that record covers accepted direct, queued, Work and scheduled automation, autorespond, and provider-switch handoff messages with actor provenance. It does not backfill provider history from before a personal-home session was admitted or user turns from before a v0.5 installation was upgraded, and those origin gaps do not set the current retention-gap field. Attachments are represented only by byte-free manifests containing bounded names, media types, sizes, and digests. Retention is capped at 50,000 events, 64 MiB, and seven days; when pruning has occurred, switch seeds and exports state the retention reason and leave the unavailable older count unknown. A switch refuses an active turn, an unsettled provider effect, an unsigned target profile, or a preset that belongs to another provider. If a Claude controller is no longer available, HRA can recover the exact conversation with `--resume` only after prior-process exit or an already-completed exact process release is proven. Ambiguous custody stays fenced in recovery without launching another process.

```text
hra session start personal --provider claude --preset fable-max --json
hra session switch <session-id> --provider claude --preset fable-max
hra session export <session-id> --format json
```

### Scheduled work in the same conversation

Attach a recurring whole-minute interval to an existing session with `hra session task`. Each run returns to that exact HRA conversation. A task cannot independently retarget its account, provider, project, model, or execution environment; later explicit changes to the session apply to future runs. Missed intervals coalesce into one queued turn. Use the returned task ID and revision for later edits or deletion; HRA never creates a replacement provider conversation or writes a provider's private automation registry.

```text
hra session task create <session-id> --name daily-review --every-minutes 1440 -- "Review the release queue."
hra session task list <session-id>
hra session task show <session-id> <task-id>
hra session task edit <session-id> <task-id> --revision <revision> --pause
hra session task edit <session-id> <task-id> --revision <revision> --resume
hra session task delete <session-id> <task-id> --revision <revision>
```

## Agent work protocol

> **Local release boundary.** These source commands are part of the `v0.7.0` local CLI candidate. Its install command becomes usable only after immutable GitHub and npm release admission. Hosted sync is not required for this local protocol; the current-daemon rollout prerequisite still applies before startup.

The versioned source contract defines a narrow local coordination kernel for agents operating several already-existing provider sessions. It records six bounded objects: work, tasks, attempts, submissions, reviews, and signals. Codex and Claude Code still own their provider-native execution, turns, tools, context, and approvals. HRA does not add a second model loop or a generic executable workflow engine.

```text
hra work protocol [--operation <kind>|--type <name>|--topic <topic>]
hra work apply --input-stdin
hra work snapshot <work> [--actor <session>]
hra work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]
hra work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1..50>] [--wait-ms <0..30000>]
hra work events <work> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>]
hra work watch <work> [--cursor <cursor>]
```

The seven commands are agent-only. Non-streaming commands emit compact JSON without requiring `--json`. `work watch` emits resumable JSON Lines. `work apply` is the only mutation entry point. It reads one strict version 1 or version 2 request from nonterminal standard input or an explicit file descriptor. Both versions contain `{protocol,version,requestId,operation}`, and the nested operation carries its UUIDv7 `idempotencyKey`. A version 2 `work.create` that declares a High or Ultra route, or `task.addBatch` that adds a High or Ultra task, also carries the caller-authored top-level `presetContract`; version 2 forbids that field on stable operations. Success and failure echo the admitted request ID and version, and work capabilities are never accepted as argv fields. The request version and any authored preset contract are part of changed-intent detection. Same-key replay of the exact request preserves the durable decision, stable identities, and capabilities without adding a mutation, event, or revision, while mutable public records and the work revision are reprojected from current state. It is not a byte-identical response promise. A retained release tombstone is the exact stored-result exception. `work protocol` is queryable by operation, type, or topic. It returns both accepted apply envelopes, exact field contracts, value syntax, capability semantics, operation kinds, hard bounds, and the closed recovery and process-exit guidance for failures.

Each task carries an exact account ID, project ID, preset, and Fast setting. HRA never chooses another subscription from quota, availability, usage, or incidental ordering. A provider limit blocks or fails that attempt. It does not rotate the task to another account. Explicit tasks on separate accounts may run in parallel.

Each Work also freezes the meaning of its High and Ultra routes when it is created. A fresh affected version 2 request must name the current contract 1 Sol meaning. A fresh affected version 1 request is refused because that format does not identify whether its author meant Sol or Astra; stable version 1 requests remain admissible. An existing contract 2 Work whose coordinator and participating session authorities remain supported keeps Astra for already-declared tasks and remains readable, claimable, reviewable, and settleable. A Work associated with a retired Devin session remains readable but is fenced from mutation and execution. Current tooling does not append a new High or Ultra task to a historical contract 2 Work because the alias now means Sol; create a new Work for a new Sol task graph. Low has the same exact Luna Max meaning under both contracts and remains compatible. Exact same-key replay of an already-applied version 1 or version 2 mutation returns its historical result without adding a task or provider effect. Reusing that key with another version or contract is a conflict, not a request to reinterpret the historical operation.

Readiness is derived from the open work state, time bounds, accepted dependency submissions, and absence of a live or ambiguous attempt. A final assistant message is not completion. The worker submits a bounded structured result and evidence; declared independent reviews and HRA-owned completion gates must accept the exact submission revision.

Dispatch binds one already-existing exact actor session and always starts a new turn. HRA's task graph is the durable task queue; queue and steer are reserved for coordination signals. HRA commits the claim, monotonic fence, route, session binding, request digest, and prepared effect before the provider call. If the provider effect may have started but cannot be proved, the attempt becomes recovery-required. HRA does not redispatch, steal, or reroute it speculatively.

Coordinator, member, and exact-attempt capabilities scope every mutation and never appear in snapshots, polls, or events. Poll action arrays have a separate signed, actor-bound continuation with a frozen projection time; a changed work stream invalidates it instead of returning stale authority.

Signal delivery and recipient acknowledgement are separate facts. `deliveryState` reports pending, accepted, failed, or unknown provider delivery. `acknowledgedAt` records the recipient acknowledgement independently, including when delivery remains pending or unknown.

Snapshots expose bounded recent work-level signals and an omitted count. With no history option, `work task` returns task detail with active and latest attempt lineage, the latest full attempt report, the latest submission and its ordered reviews, and bounded recent task signals. Either `--history-limit` or `--history-cursor` selects a separate task-history page over the task's attempts, reports, submissions, reviews, and task signals; a cursor-only continuation defaults to 20 items. Each complete compact JSON response for snapshot, task detail, and task history, including its envelope and terminating newline, is capped at 512 KiB. Only recent or historical arrays are trimmed, and omitted or remaining counts and continuations make every reduction explicit.

A signed task-history continuation freezes the work stream sequence and epoch, task membership high-water ordinal, task revision, projection time, and next offset. Append-only bounded public projection versions reconstruct every returned record as of that cut. Later mutations and later history memberships are excluded from every continued page, so pagination is coherent even while agents keep working.

Each JSONL gap, event, or checkpoint frame, including its terminating newline and terminal-safe escaping, is capped at 512 KiB. A terminal stream failure is one compact JSON document on stderr capped at 64 KiB. The queryable protocol advertises both wire limits.

Accepted submissions, reviews, evidence references, receipts, and completed tasks are durable prefixes. Later failure or cancellation preserves them. No SQLite writer transaction spans provider reasoning, provider I/O, artifact hashing, or Git inspection. This applies the durable-prefix lesson in [Agent Swarms are a Distributed Systems Problem](https://www.trychroma.com/engineering/transactions) without adopting generic page locking, wound-wait, or speculative replay.

`task.claimNext` records an exact idempotent empty result when no task is ready without appending an event or advancing the work revision. `work.release` is the other stream-neutral mutation. It requires terminal work, the exact coordinator capability and revision, and `acknowledgeDataLoss: true`. Only an unresolved attempt dispatch blocks release. An ambiguous signal delivery may be discarded under that acknowledgement and is counted in the tombstone.

A successful release atomically deletes the work graph and durable history, including the task-history membership index and projection versions, then retains a separately bounded tombstone with the final stream head, terminal and release request digests, discarded-record counts for both history tables and the rest of the graph, and a digest of that release boundary. While the tombstone remains, only the same release idempotency key and canonical request digest have an exact replay result. Replay guarantees for every earlier operation have ended. Tombstones have count, byte, and maximum-age bounds, so their retention timestamp is an upper bound rather than a promise.

This release is an explicit logical destructive purge, not a forensic-erasure promise. SQLite secure deletion is defense in depth, but the command does not promise immediate physical sanitization of prior database pages, WAL frames, backups, snapshots, or storage media.

Local SQLite is the only execution authority for work admission, claims, fences, dispatch receipts, submissions, reviews, signals, and the work-scoped event cursor. The initial work protocol has no cloud execution or cross-device takeover path. Turso is deferred behind a repository boundary and cannot be added as a second authority beside SQLite or encrypted Convex projections.

## Cloud sign-in and device pairing

> **Conditional walkthrough.** Current daemon and hosted command-writer rollout remains blocked on capacity. Do not initialize, start, or autostart the admitted v0.6.3 daemon or candidate v0.7.0 daemon until the hosted operator records protected two-pass zero-debt capacity evidence and its exact .activated readback receipt. Artifact availability, candidate readiness, and the live sync service do not clear this gate. After activation, complete the update runbook's daemon and target marker-2 proofs before globally enabling hosted writers.

The hosted endpoint is live as an open beta. An unset `HRA_CONVEX_URL` selects HRA's hosted deployment. Set it to an explicit empty value before the first daemon starts to disable cloud transport. A nonempty HTTPS value selects a self-managed Convex deployment. The first valid selection permanently binds that local state root; a later mismatch fails closed instead of moving credentials or recovery state. After deliberately disabling a bound state root, `hra sync status` and `hra doctor` report its exact restart prerequisite: unset `HRA_CONVEX_URL` for the hosted deployment, or restore the bound URL for a self-managed deployment. HRA accepts cloud credentials only as protected JSON on standard input or a nonterminal file descriptor. It rejects email addresses, identity invites, and verification codes on the command line:

```text
hra auth login --input-stdin
hra auth login --input-fd <fd>
hra device pair
hra device key-loss --acknowledge-no-key-holders
hra sync status
```

Each login reads exactly one JSON document. Request a code for an existing identity with `{"email":"you@example.com"}`, create a new identity with `{"email":"you@example.com","invite":"<identity-invite>"}`, or verify a requested code with `{"email":"you@example.com","code":"12345678"}`. No other keys or combinations are accepted. A TTY prompt hides the document; agents should pass a private descriptor with `--input-fd <fd>`. The document is never an argument.

The CLI stores HRA's revocable device credential, workspace encryption key, and local signing authority as immutable generations below its private state root. Custody directories are current-user-owned mode-0700 directories, values are single-link mode-0600 files, and reads use bounded no-follow descriptors. The detached Bun daemon never opens a Keychain prompt. HRA forces both pinned Codex credential stores to file mode and verifies their effective settings. Managed Codex accounts keep credentials in each profile's isolated `CODEX_HOME`. Claude Code receives that profile's isolated `CLAUDE_CONFIG_DIR`; HRA treats the whole directory as Claude's authentication boundary and never reads, copies, or forwards its credentials. Explicitly adopted Codex and Claude Code personal sessions use credentials already owned by the user's personal provider home without copying or parsing them. Provider-managed credential storage remains owned by the provider runtime.

After successful email verification, the daemon automatically registers the current installation before it reads cloud data. The first registered device becomes active and creates the client-side encryption key. A later verified installation is registered as pending and may report presence, but it has no synchronized data, execution, or key authority.

On an already active machine, list devices and approve the pending device by its exact ID or unique prefix. The listing shows each device's class, daemon or browser, and the fingerprint of its two public keys. Approval requires that exact fingerprint, so the machine you approve is the one whose fingerprint you read:

```text
hra device list
hra device approve <pending-device-id-or-prefix> --fingerprint <value> [--idempotency-key <current-uuidv7>]
```

After approval, run `hra device pair` on the new machine to retrieve and unwrap its encryption-key envelope. Use `hra device revoke <device-id-or-prefix>` from a different active machine to revoke a device.

`hra auth status` and `hra sync status` expose the account key as a closed status. `ready` includes the usable key version. `pairing_required` says recovery requires an existing account-key holder and that no remaining holder makes the encrypted content unrecoverable.

Only after this authenticated, registered, active installation reports `pairing_required` and the operator has confirmed that no account-key holder remains, run `hra device key-loss --acknowledge-no-key-holders`. The command records that explicit observation in the current HRA cloud identity's isolated local custody, but only when the current auth token generation, identity, auth epoch, registered device, and pairing observation agree exactly. It performs no network, provider, or cloud mutation and does not mint, replace, or delete a key or ciphertext. Signed-out, unregistered, stale-identity, missing-observation, and already-ready states fail with a bounded next command. Pairing the real account key later supersedes the observation.

> **Unrecoverable encrypted cloud content.** After that acknowledgement, account-key status is unrecoverable on this installation. Local provider profiles, sessions, credentials, and execution are unaffected, but existing encrypted cloud content cannot be decrypted without the real account key. Search again for an existing holder and run hra device pair if one is rediscovered; the real key restores ready status and supersedes the acknowledgement. Only after that renewed holder search is exhausted may the operator explicitly choose erasing and reinitializing the HRA cloud account as a fallback. Reinitialization creates a new account boundary; it does not regenerate the lost account key or recover old ciphertext.

Approve and revoke create one current UUIDv7 before daemon transport. If the response is lost after dispatch, HRA prints the exact same-key replay command. Reusing that command recovers the original operation; changing the device or operation under the same key is rejected.

Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked.

Cloud-account erasure is an explicit and irreversible fallback, not the default response to a key-loss acknowledgement. After a renewed holder search is exhausted, run `hra auth delete --acknowledge-erasure` to disable every cloud effect before bounded server-side removal begins. `hra auth status` recovers capability-only progress after authentication records disappear. Erasure does not delete local provider profiles, local sessions, or local encryption custody.

## Features

- Isolated provider profiles: each named profile has its own user-only `CODEX_HOME` for Codex and `CLAUDE_CONFIG_DIR` for Claude Code. Each provider owns its authentication state; HRA never copies or parses provider credentials.
- Codex usage with provenance: account identity, quota, rate-limit, and token snapshots include their provider source time and freshness. A bounded source-ordered 24-hour ledger supports safe human and JSON pagination without returning raw provider payloads.
- Compact sessions: list sessions, read provider-neutral user and final assistant messages, and inspect elapsed time plus bounded observed file and Git actions. Protected full-turn inspection remains Codex-only.
- Personal-home adoption: opt in to discover recent Codex and Claude Code sessions, plus older Codex threads targeted by present Desktop heartbeat automations, then admit them after bounded account, project, liveness, and exact-resume checks. Active and paused automation records both count until deletion or retargeting. HRA locally parses a bounded automation record but ignores and retains no prompt or working-directory field, keeps later records reachable across daemon restarts, and replaces Desktop's exact fired heartbeat envelope with generic protected text before projection. Account-filtered session lists include admitted rows, which use the same provider-supported public commands, autorespond policy, and approval authority as every HRA session. Provider-specific limits are identical for native and adopted sessions, and provider APIs do not supply a global lease against every later external resume. Read [the session-adoption guide](https://github.com/hraness/hra/blob/main/docs/session-adoption.md).
- Durable controls: send, queue, stop, and keep one editable note per session. Codex and Claude Code can steer an active turn. Provider-native rename remains Codex-only. Provider and desktop effects use exact authority, idempotency keys, and process-generation fencing.
- Named projects: a project is a canonical directory that may contain several repositories. Changing it affects future turns only.
- Stable working and shared project memory: a project-bound session writes to its expiring working lane, reads that lane together with durable project memory, and shares one attested page only through conflict-checked adoption. Bound Codex and Claude Code models use closed HRA tools. Owners use `hra memory status|list|get|search|explain|remember|share` and explicitly enroll canonical project memory through `hra memory hosted list|create|attach|detach|sync`. Existing personal adoptions and legacy sessions without a proved HRA tool binding use the owner memory CLI; adoption does not silently install model tools or replace their conversation. Hosted memory is opt-in and does not upload the working lane. See [working and project memory](https://github.com/hraness/hra/blob/main/docs/facts-memory.md) for the authority, quota, and recovery boundaries.
- Attributed peer coordination: each session owns a revocable `off|inspect|coordinate` policy. Bound Codex and Claude Code tools can list, inspect, and message only bounded same-project peers; every action retains actor and lineage without granting session administration or approval authority. Retired sessions cannot participate.
- Agent work coordination: the frozen beta contract specifies bounded local task graphs, fenced attempts, structured submissions, independent reviews, signals, and a resumable work event stream for exact existing sessions.
- Optional encrypted sync: paired devices share a bounded session projection and submit commands to the one machine holding the execution lease.

### Peer coordination boundary

Peer coordination is separate from Work. It creates no Work, task, attempt, review, or signal membership. The actor and target must be distinct current sessions in the same project. Inspection requires neither policy to be `off`; messaging requires both exact current policy revisions to remain `coordinate`. Changing either policy revokes stale inspection and mutation authority.

`send` starts a new turn only for an idle target. `queue` records bounded untrusted input for later delivery and works for an active target. `steer` addresses one exact active turn and is supported by Codex and Claude Code. Peer input cannot resolve approvals, answer protected questions, administer a session, or inherit an identity.

HRA refuses self-addressing, stale target revisions, causal cycles, and a ninth hop. It admits at most 120 new peer actions per actor and per project in a rolling hour, at most 16 distinct targets per actor in that hour, and at most 64 unsettled inbound queue entries or 1 MiB of their text per target. Complete replay and causal evidence remains for at least seven days. Protected recovery ancestry is never pruned to make room, and the 25,000-action project cap fails closed when protected rows consume it.

Abandoning an uncertain peer delivery does not prove that its message was ignored. HRA refuses new peer messages from an affected active turn while preserving inspection and owner controls, including stop. A subsequent distinct turn can coordinate again. Older unreleased recovery records with no affected-turn identity conservatively fence that provider thread until the owner explicitly replaces it; a new message alone does not repair missing historical evidence.

## Terminal and agent interfaces

> **Conditional walkthrough.** Current daemon and hosted command-writer rollout remains blocked on capacity. Do not initialize, start, or autostart the admitted v0.6.3 daemon or candidate v0.7.0 daemon until the hosted operator records protected two-pass zero-debt capacity evidence and its exact .activated readback receipt. Artifact availability, candidate readiness, and the live sync service do not clear this gate. After activation, complete the update runbook's daemon and target marker-2 proofs before globally enabling hosted writers.

Run `hra` in a TTY to open a persistent shell. Account and session selections stay in the prompt, live updates redraw wrapped partial input without moving its logical cursor, protected answers are read without terminal echo, and `/exit` leaves the daemon running. Pasted command lines use a bounded queue. An overflow or interrupted line flushes the current native terminal queue, retains input custody while discarding through EOF, and exits without executing the tail. Protected terminal documents require a visible stderr TTY plus unpredictable begin and return phrases while raw no-echo mode is active. A failed protected boundary keeps echo disabled while discarding the tail, then closes shell input instead of returning ambiguous bytes to an ordinary prompt. Display loss, termination, and job-control signals restore or fence raw mode before propagation. Live display is buffered while a foreground or protected prompt owns the terminal, and updates from an old session generation are discarded before a new selection is announced. Slow-terminal backpressure drops additional updates behind one explicit omission notice instead of growing memory without bound. One-shot commands provide the same control surface to scripts and agents.

### Bounded local status

`hra status [--json]` is a bounded, effect-free read of local SQLite state. It does not start, stop, or contact the daemon; use the network; attempt provider or cloud observation; open a browser; log in; refresh usage; or run recovery. It returns fixed count fields for account, session, interaction, queue, and latest usage states plus at most 50 ID-and-revision action records. Provider and cloud coverage are explicitly `not_attempted`, and registered and online device counts are unknown rather than zero. The complete JSON result, including its versioned command envelope, is at most 256 KiB.

```text
hra status
hra status --json
```

### Session observation

`hra session status <session> --json` returns status version 2. HRA produces one typed provider-observation result, attempting the bound provider's reviewed observation path only when the current local state makes one applicable, then reads the session, event cut, interactions, and queue from one local SQLite transaction. Codex supports a native app-server observation read. Claude Code uses its live provider-neutral projection while the exact controller is present. If that controller is absent, HRA may establish `--resume` for the exact conversation only after prior-process exit or an already-completed exact process release is proven; ambiguous custody fails closed as recovery required. Retired Devin sessions use local history only and cannot execute. Execution, attention, provider, and queue remain separate axes, so a headline state cannot hide a recovery condition, pending interaction, response in flight, or queued work. Pending and response-in-flight counts are exact. The result includes at most 10 bounded safe summaries for pending interactions and excludes the session note and private provider thread binding. Every provider turn and item identifier becomes a secret-keyed opaque public alias before status, event, or interaction output. Public observation schemas accept only that exact alias form. The same local installation key keeps aliases coherent across surfaces and daemon restarts without making low-entropy provider IDs guessable from public output. If an existing installation loses that key, HRA refuses to replace it and directs the operator to restore the original local secret.

`hra session state <session> --json` returns the daemon's latest classification of who must act next: working, needs approval, needs an answer, needs a human action, done, done with followups, done with caveats, or aborted, with an attention flag, a short reason, and a monotonic revision. The daemon classifies the final assistant text of every completed turn with ordered lexical rules in which human-action cues beat approval cues, so a login or a code from email never reads as consent, and it reclassifies when a provider interaction is requested or resolved. The same classification is appended to the session event stream as a `session_state` event.

Autorespond answers provider approvals on your behalf. By default every session runs in approval mode `auto:all`: command and permission approvals are accepted immediately at once scope, never for the session, and each answer leaves an evidence row with the approval class, decision, mode, latency, and outcome. File-change approvals stay pending because the pinned callback does not expose the exact affected paths. `hra autorespond workspace` leaves command and permission grants pending until a provider adapter can attest their complete private authority as workspace-local; a command class or category label such as `workspace_write` is not that proof. `hra autorespond off` restores manual approvals; add `--session <session>` to override one session and `default` to clear the override. Questions and MCP forms are never answered automatically. The baseline limits are three consecutive answers without a human message, ten in an hour, and forty in a day. `hra autorespond status --session <session>` shows the shared counters and the last twenty evidence rows. Only an actual human-authored message resets the consecutive counter; peer messages, Work and scheduled automation, autorespond, and provider-switch handoff messages do not. Notification consent never enables automatic approvals.

After-hours protocol budgets were admitted in v0.6.3. They use a separate local opt-in, disabled on new and upgraded installations. The v0.7.0 candidate retains this policy without enabling it. After the applicable artifact admission and daemon rollout gates are satisfied, `hra autorespond-after-hours status` reports that policy and its revision. To opt in explicitly, use `hra autorespond-after-hours enable --revision <revision>`; use `hra autorespond-after-hours disable --revision <revision>` to turn it off. Outside the configured notification hours, otherwise eligible protocol approvals with complete budget history may use six consecutive, twenty rolling-hour, and eighty rolling-day reservations. Inside hours or without eligible evidence, the baseline applies. Prose always stays at three, ten, and forty. Both paths spend the same counters. Policy changes and schedule boundaries never reset or refund them, and no approval category gains authority.

Each automatic approval reserves its budget before provider dispatch. Reservations survive uncertain results, daemon restarts, and pruning of the display log; a reserved attempt can remain charged even if a later step proves unsent. The final storage transaction checks current consent, source eligibility, and shared accounting before charging. Higher limits additionally require one coherent current schedule and proven history; an unreadable schedule selects the baseline, while invalid consent or accounting refuses admission. Upgrading an existing session to local schema 44 pauses automatic approvals for 24 hours because older retained logs cannot prove its complete budget history, and requires a new human message to reopen its consecutive budget. You can send that message during the hold. The schema-46 after-hours migration also requires a newly finalized human message for every pre-44 session before its higher tier can apply, even if the old hold expired or a human reset occurred before that migration. `hra autorespond status --session <session>` reports the hold's end and the consecutive counter. Manual approvals remain available.

Configuring a gateway key explicitly enables the separate prose-approval path. After strict local gates establish that a completed final assistant message asks only for consent, HRA sends at most its final 4,000 characters plus session-state and approval-reason metadata to Vercel AI Gateway model `openai/gpt-5-nano`. It makes one request with a 10-second deadline and no retry. The model cannot create arbitrary text that HRA will send: the daemon emits either `The human has approved. Proceed accordingly.` or a byte-exact substring already present in the assistant message. Immediately before dispatch, HRA checks current consent, the exact completed question, pending interactions, and shared budget again. A newer question or changed authority cancels the stale reply. A timeout, refusal, or other failure leaves the turn for the human. `hra autorespond gateway clear` disables this prose path.

For snapshot-to-stream continuity, start selected-session monitoring at the atomic status cursor. `hra session watch <session> [--cursor <cursor>]` renders a bounded human stream by default; add `--jsonl` for a machine stream. Watch is a presentation alias over the existing session event stream, and it drains each output page before advancing its internal cursor. The shell drains every signed pending-interaction continuation page before following newer committed ledger events from the status cursor. Standalone human watch buffers that initial guidance until enumeration is complete, caps the atomic bootstrap at 1 MiB of UTF-8, and writes none of it if enumeration or the bound fails. Resolution guidance appears only from a complete current interaction record and only for a supported decision; an event-only interaction notice points to the exact show command without proposing a mutation. Those events cover bounded lifecycle, tool, interaction, warning, error, and terminal updates, but the ledger is not a complete wake source for every authority transition. Agents that need exact current authority must also repeat bounded session status or pending-interaction reads. Human watch renders assistant and provider-visible reasoning-summary text only after observing that item's start boundary, then redacts credentials and absolute paths with state carried across chunks and interleaved events. A mid-item join omits ambiguous delta suffixes until the next item starts. Gaps, shutdown, malformed repeated starts, and exhausted redaction capacity discard undecided tails with an explicit notice rather than releasing text whose boundary cannot be proved.

```text
hra
hra session status <session> --json
hra session state <session> --json
hra session watch <session> --cursor <cursor>
hra session watch <session> --cursor <cursor> --jsonl
hra session events <session> --cursor <cursor> --limit <1..200> --wait-ms <0..30000> --json
hra session events <session> --cursor <cursor> --wait-ms 30000 --jsonl
hra session interactions <session> --pending --json
hra interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]
```

JSON mode writes one versioned document to stdout and diagnostics to stderr. Event following with `--jsonl` writes JSON Lines as the turn progresses; `--follow` remains an equivalent compatibility spelling for `session events`. JSONL delivery is at least once across a pipe or process failure: a crash after an event line but before its page checkpoint can replay that event. Durable consumers deduplicate by `(sessionId, streamEpoch, sequence)` and persist each checkpoint only after durably applying all preceding lines. Signed opaque cursors let an agent resume bounded session-list, event, and interaction pages, and durable interaction records keep approvals, questions, permission grants, and MCP form elicitation visible until they are explicitly resolved.

Exact `hra session wait` is unavailable until every wait predicate has a transactional wake revision that changes in the same commit as the observed state. Use status followed by watch from its cursor, or bounded repeated status polling, when a caller needs to wait.

### Exit status and JSONL

Every one-shot caller must check the process exit status. HRA uses this exact mapping:

- `0`: success. A normally stopped event follower, including a user SIGINT, may also return 0.
- `1`: CONFLICT, AMBIGUOUS, INTERNAL, any other closed failure code, or an unhealthy doctor result.
- `2`: INVALID_INPUT.
- `4`: NOT_FOUND.
- `5`: UNAVAILABLE.
- `6`: INTERACTION_REQUIRED.
- `7`: RECOVERY_REQUIRED.

For non-streaming `--json` commands, stdout contains exactly one versioned success or failure envelope. For `--jsonl` or its equivalent `--follow`, stdout contains only JSONL gap, event, and checkpoint frames. If the follower ends on a command error, HRA leaves all completed frames on stdout and writes exactly one newline-terminated version-1 failure envelope to stderr shaped as `{"ok":false,"version":1,"error":{"code":"<code>","message":"<safe-message>"}}`; the error may also include bounded details. Callers must consume stdout and stderr independently, must not merge the terminal error into the JSONL stream, and must check the process exit status. A normal user stop or SIGINT may exit 0 without a terminal failure envelope.

`interaction show` intentionally returns only a durable safe summary. Before approving a command or permission request, run `hra interaction inspect <interaction-id> --revision <n>` to read the complete authority still held by the live provider callback. A foreground human receives bounded detail on the protected stderr terminal. An agent or other noninteractive caller must first create an empty mode-0600 regular file under a current-user-owned mode-0700 directory and pass its absolute canonical path with `--handoff-file`; ordinary stdout receives only safe binding and cleanup metadata. On macOS, neither the directory nor file may have an extended ACL, and HRA rechecks both held descriptors before and after writing. Detail larger than 64 KiB also requires this file path. Read it within that protected boundary and remove it after deciding. HRA durably admits a bounded file-change prompt so it remains observable and may be declined, but refuses every acceptance because pinned Codex 0.153.2 does not provide the exact affected paths or change detail needed for informed approval.

## Presets and permissions

> **Conditional walkthrough.** Current daemon and hosted command-writer rollout remains blocked on capacity. Do not initialize, start, or autostart the admitted v0.6.3 daemon or candidate v0.7.0 daemon until the hosted operator records protected two-pass zero-debt capacity evidence and its exact .activated readback receipt. Artifact availability, candidate readiness, and the live sync service do not clear this gate. After activation, complete the update runbook's daemon and target marker-2 proofs before globally enabling hosted writers.

HRA reviews the bound provider's exact runtime profile immediately before each new provider-native session or turn. For Codex, that refresh includes model, reasoning effort, Fast service tier, permission profile, computer-use capability, and accessible apps. For Claude, HRA admits only the pinned Fable profile and reviewed host-tool boundary. An unavailable requirement fails before the provider effect. Every successful start records that exact account generation and effective profile; `hra session show` displays the bound provider's history and recorded public profile. Read the provider-neutral HRA record with `hra session export` or the transcript endpoint. Codex profiles include the requested model, reasoning effort, service tier, permission profile, computer-use capability, and accessible apps; an empty enabled-app list is reported as empty. Claude Code public profiles include the pinned CLI, model, reasoning effort, default permission mode, and stream formats. HRA privately reviews the exact config-home authority for every Claude effect but omits that custody identity and legacy isolation marker from `session show`; managed and adopted personal-home sessions therefore share one non-identifying public shape. Each provider remains authoritative for its native permissions, tools, and hidden runtime state.

- `low`: Codex Luna Max, currently `gpt-5.6-luna` with `max` reasoning.
- `high`: Codex Sol Max, currently `gpt-5.6-sol` with `max` reasoning.
- `ultra`: Codex Sol Ultra, currently `gpt-5.6-sol` with `ultra` reasoning.
- `fable-max`: Claude Code Fable, currently `claude-fable-5-1` with `max` reasoning.
- `fast on|off`: a Codex-only, explicit per-turn Fast or Standard overlay. Claude Code refuses Fast instead of ignoring it. A prior Fast value cannot leak into the next turn.

New HRA-created Codex sessions that use `high` or `ultra`, and explicit selections of either preset, use the Sol mapping above. The `low` and `fable-max` bindings are unchanged. Codex sessions already bound to historical contract 2 keep their exact Astra model and effort until a preset is explicitly selected; unrelated metadata edits, restart recovery, and queued work do not reinterpret an established session.

`hra init` reports the required confirmation without changing local state; `hra init --yes` creates your Documents directory when it is absent, verifies that it is a readable, writable, and traversable canonical directory, and accepts it as the default project. Initialization is a one-shot maintenance command: run it before opening the persistent shell. The shell rejects `/init` because its running daemon already owns local state. Codex turns use Codex's `auto_review` path, the exact advertised `:workspace` permission profile, and the selected project as the runtime workspace root. Codex remains authoritative for the profile's effective sandbox, network policy, computer use, plugins, and protected turn inspection. Claude Code runs in its default interactive permission mode under the selected project and maps supported tool-use requests into HRA interactions; it does not expose Codex's permission-profile, app, plugin, or protected turn-inspection surfaces.

## Plugin discovery

```text
hra plugin list <account> [--project <project>] [--refresh]
hra plugin show <account> <plugin> [--project <project>] [--refresh]
```

Plugin commands are read-only discovery. They report the exact installed, enabled, availability, authorization, and capability state exposed by the selected isolated Codex profile.

Pinned Codex 0.153.2 has no safely separated install, enablement, and OAuth lifecycle surface: its available lifecycle path can combine installation with enablement and may then open browser authorization. HRA therefore does not expose plugin install, enable, disable, OAuth, or permission effects. The pinned tool-suggestion form that can invoke that compound plugin or connector lifecycle is also rejected before admission. Other standard MCP forms are brokered only when their pinned schema fits HRA's closed primitive-field contract. The interaction exposes bounded field names, types, requiredness, constraints, and allowed choices; titles, descriptions, defaults, and answers stay off the public and durable display. Protected submissions are checked for exact required fields, types, bounds, formats, choices, and the absence of additional properties before response preparation. Opaque openai/form, unsupported schema constructs, and URL elicitation fail before durable admission and receive a safe unsupported-capability response with no schema, submitted value, or URL echo. The schema-11 security migration terminalizes and replaces any prerelease URL record before interaction reads. HRA will keep extended-form and URL handoff unavailable until each has a closed protected path.

## Desktop account switching

`hra account switch <profile>` is experimental and macOS-only in the first beta. The current compatibility gate accepts only the signed OpenAI ChatGPT application at `/Applications/ChatGPT.app` with reviewed version, build, CDHash, and isolated-profile launch hooks. Unsupported or changed bundles fail before quit.

A switch requires a signed-in target with a verified provider email, takes one machine-global lock, rejects multiple exact app processes, and refuses an unsettled earlier switch. It journals the target generation, gracefully quits the exact process, waits for exit, relaunches once with the target's isolated Codex and desktop-data roots, and binds read-only account verification to that launched PID, executable, CDHash, and environment.

The experimental desktop switch never copies `auth.json`, swaps one token, changes Keychain blindly, responds to a provider limit, or retries an uncertain switch. An uncertain quit, transition, or relaunch becomes `recovery_required` and preserves both profiles. Run `hra account switch-recover` to reconcile only the current attempt. Recovery performs bounded read-only bundle, process, environment, and account observations; it never quits or launches the app. It releases the switch authority only when those observations prove the target account is active or prove that no target instance remains.

## Sessions across machines

The machine that created a provider session remains its only executor in v1. It must be online with its HRA daemon running and must hold the current execution lease before a remote command can affect Codex or Claude Code. Other paired machines never execute that provider session through one of their own local provider profiles.

Paired machines can read the encrypted projection and submit bounded send, queue, steer, stop, preset, provider-switch, and Codex Fast commands. The origin daemon claims each command by lease generation and idempotency key. Commands remain pending within their deadline while the origin machine is offline; another machine cannot take over or become a second provider writer.

`hra remote show` includes interaction events with a public interaction ID, kind, state, revision, blocking status, bounded safe summary, and a nested version 2 remote policy. That policy is the only remote action authority. Provider request IDs, exact commands, permission values, affected paths, MCP fields, protected answers, and response digests remain local. Another device may decline a pending command, permission, or file-change request with `hra remote resolve <cloud-session> --interaction <id> --revision <n> --decision decline`. The web app may answer only a complete non-secret closed-choice user question set whose provider adapter proves exact response translation. Every command, permission, or file-change acceptance or grant, cancel, session scope, free-text or Other response, and every MCP answer stays on the execution machine. A missing policy, nested policy version 1, or unknown policy version exposes no control. The execution daemon rechecks the session, revision, pending state, deadline, requesting device, and exact action membership before using the ordinary local resolution path. `hra remote send --or-steer` lets the execution device decide whether a message steers the active turn or starts a new one, because a remote view of turn state is always slightly stale.

```text
hra remote list
hra remote show <cloud-session>
hra remote command <uuidv7>
hra remote send <cloud-session> <message>
hra remote queue|steer <cloud-session> <message>
hra remote stop <cloud-session>
hra remote preset <cloud-session> <low|high|ultra|fable-max>
hra remote provider <cloud-session> <codex|claude> [--preset <low|high|ultra|fable-max>]
hra remote fast <cloud-session> <on|off>
hra remote allow|deny <device-commands|account-linking>
hra remote policy
```

A cloud-session selector accepts an exact public ID, a unique public-ID prefix, or an exact synced name. HRA resolves that selector to the session's exact execution device before enqueueing. Remote mutations accept `--idempotency-key <current-uuidv7>` for explicit lost-response recovery; otherwise the CLI creates one and durably recovers an unsettled encrypted outbox entry before accepting a different command. Every enqueue returns its command ID. Use `hra remote command <uuidv7>` to read its bounded current or terminal state and result code, including a failed or ambiguous outcome.

Transcript upload is bound to a durable local stream ledger and the exact remote head and tail. Missing or mismatched evidence pauses upload for only that session. Remote reads, commands, and usage continue, while `hra sync status` keeps the recovery condition visible. HRA never resets, aliases, overwrites, or destructively reseeds encrypted history.

```text
hra sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]
```

Projection recovery is an explicit append-only operation. Running it without `--acknowledge-gap` performs no daemon call and returns `INTERACTION_REQUIRED` with the exact safe next command. JSON mode never prompts. The acknowledged operation preserves all older encrypted cloud history and changes no provider or app state. It opens the next compact stream epoch at sequence `H+1`, where `H` is the exact remote compact head, and baselines only completed turns currently visible in the bounded local projection. Any possibly unsynced interval remains visible to remote readers as a recovery gap.

The CLI creates a current UUIDv7 before daemon transport. Success reports the phase, local session, old and new epochs, boundary head, persistent gap, and an exact same-key replay command. A prepared recovery inside the seven-day server window renews its execution lease and keeps the same exact key. Changed-key retry remains closed while that recovery is unsettled. After the window, exact-key replay first reconciles an already committed effect from immutable lineage. If no effect began, it discards local staging, settles the old attempt as rejected, and clears its authority. Run `hra sync status --json`, then start a fresh recovery without `--idempotency-key` if recovery is still required.

Session names and notes sync as encrypted metadata, but v1 does not execute remote rename or note commands. Project directories are local-only and are neither synced nor remotely changed.

## Privacy

Cloud sync is optional. Local provider profiles, Codex credentials, Claude Code configuration and credentials, and local execution continue to work without it. HRA identity is separate from every provider account.

### Encrypted before upload

- User messages and final assistant display text. This includes peer-session messages and their supplied reasons when HRA records them as transcript messages.
- Session names, notes, queued messages, and steering input.
- Codex account labels and observed provider email and plan metadata when cloud sync is enabled. Claude Code account identity and usage are not projected. For managed profiles, HRA validates one bounded Claude Code authentication-status response transiently, reduces it to signedIn, and never retains, returns, projects, or uploads the identity or usage fields. Personal-home Claude adoption transiently reads bounded account, email, and organization identity metadata and retains only a one-way local authority key. Raw Claude identity fields and that private authority key are never publicly returned, projected, or uploaded; HRA never opens or parses a Claude credential file.
- Codex and Claude Code personal-session adoption status: whether discovery is enabled and bounded pending, adopted, and fenced counts. Candidate identities and records are never included.
- Turn timing, observed model and tier, and provider usage summaries.
- Bounded observed file and Git metadata, without unbounded filesystem paths.
- Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.
- Remote-command input and results that fit the closed command protocol.
- Canonical Oh operations, including their page records and provenance, terminal-head proofs, portable adoption proofs, and hosted-space descriptors for projects the owner explicitly enrolls in hosted memory.
- A bounded read-only memory summary containing portable space and project labels, exact head and sync metadata, record counts and recent record keys, effective peer policies, and content-free recent peer-action state. Authenticated coverage markers distinguish complete from bounded selections. This summary excludes page bodies, peer message text, action reasons, raw local project or session IDs, paths, and Oh operation bytes.
- For an explicitly requested Codex web login, the provider HTTPS verification URL and separate one-time user code. HRA encrypts both to the account key before upload, lets only the requesting browser read them once, and deletes the hosted handoff on that read or after five minutes.

### Never uploaded

- Codex or Claude Code credentials; provider profile or configuration files; plugin credentials; OAuth access or refresh tokens; authorization codes; PKCE verifiers; provider cookies; or the private device code.
- Raw Codex app-server or Claude Code stream requests or responses.
- Personal-home adoption candidate identities or records, personal-runtime bindings, process identities, schedule-source metadata, provider-home provenance, provider-account authority hashes, or the automation id, firing time, and instructions from an exact Codex Desktop heartbeat envelope. Such an envelope is replaced with generic protected text before session content is projected.
- Raw reasoning, hidden chain of thought, or approval secrets.
- Provider-internal login and request IDs, permission values, MCP field contracts, protected answers, or response digests.
- Environment variables, arbitrary command output, or unbounded filesystem paths.
- Working-memory Oh records and database bytes; canonical operations or page bodies outside their encrypted operation envelopes; and local Oh database paths.

The sync service necessarily sees the verified HRA email address, device identifiers, opaque hosted-space identifiers, record types, revisions and key versions, ciphertext sizes, timestamps, execution-lease or command lifecycle metadata, and canonical-memory sequences plus keyed head tokens. It cannot decrypt session or memory content without a paired device key. Email access alone does not recover that key.

A browser device holds the account key and decrypted projection only in that tab's memory by default. HRA does not programmatically write decrypted provider or session text to the clipboard, but browser extensions, accessibility APIs, screenshots, and explicit user selection can observe rendered text.

HRA uses Convex to authenticate the HRA identity and store server-visible metadata plus encrypted projections. Convex receives the verified email address and the service metadata described above, but not the keys required to decrypt session content.

HRA uses Resend to deliver verification email. Resend receives the recipient email address, sender identity, one-time verification code and message content, and ordinary delivery metadata. It receives no provider credentials or encrypted session projection.

HRA uses anonymous, cookieless PostHog analytics on the public hra.sh pages to count page views and page leaves and measure selected Web Vitals. Collection runs only on the canonical production host, honors Do Not Track, keeps its visitor identifier in memory, and disables person profiles, autocapture, heatmaps, feature flags, surveys, conversations, and session recording. PostHog receives the canonical route, bounded referral classification, browser performance measurements, a cookieless visitor identifier, and ordinary request metadata such as IP address, user agent, and time. HRA sends no form values, account identity, provider or session data, URL query, or fragment. Vercel serves hra.sh, and GitHub hosts the source repository, releases, and release downloads; those providers receive ordinary request metadata when visited.

Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked.

Compact-projection recovery is append-only. It preserves every older encrypted cloud chunk, opens a new stream epoch, and keeps the acknowledged unsynced interval visible as a recovery gap until authenticated account deletion.

Codex activity remains subject to OpenAI's service and privacy terms. Claude Code activity remains subject to Anthropic's service and privacy terms.

> **Hosted sync status.** The hosted sync endpoint is live as an open beta. Authenticated account deletion and capability-only progress recovery are implemented and pass deterministic hostile tests. Anyone can create an identity with an email address and a one-time code; an invitation is optional.

## Command reference

```text
hra init [--yes] [--json]
hra status [--json]
hra doctor [--offline] [--json]
hra auth login --input-stdin|--input-fd <fd>
hra auth status|logout
hra auth delete --acknowledge-erasure
hra usage auto status [codex|claude] [--json]
hra usage auto on|off [codex|claude] --revision <n> --idempotency-key <uuid> [--json]
hra usage auto inherit <codex|claude> --revision <n> --idempotency-key <uuid> [--json]
hra notification-hours status [--json]
hra notification-hours set --start <HH:MM> --end <HH:MM> --timezone <IANA-zone> --revision <n> [--json]
hra notification-email status [--json]
hra notification-email enable|disable --revision <n> [--json]
hra device list
hra device pair
hra device key-loss --acknowledge-no-key-holders
hra device approve <device-id-or-prefix> --fingerprint <value> [--idempotency-key <uuidv7>] [--json]
hra device revoke <device-id-or-prefix> [--idempotency-key <uuidv7>] [--json]
hra account add <label>
hra account login <profile> [--provider <codex|claude>] [--device-code] [--handoff-file <absolute-path>] [--idempotency-key <uuid>]
hra account login-cancel <profile> [--provider codex]
hra account login-cancel <profile> --provider claude --attempt-id <attempt-id> --provider-generation <n> --idempotency-key <uuid> --acknowledge-child-exited
hra account login-cancel <profile> --provider devin --attempt-id <attempt-id> --provider-generation <n> --idempotency-key <uuid> --acknowledge-child-exited
hra account logout <profile>
hra account list
hra account list [--provider <codex|claude>] [--json]
hra account show <profile> [--provider <codex|claude>]
hra account show <profile> --provider devin  (retired local history and cleanup only)
hra account usage [profile] [--refresh]
hra account usage-history <profile> [--from <UTC-RFC3339>] [--through <UTC-RFC3339>] [--limit <1..100>] [--cursor <cursor>]
hra account switch <profile>
hra account switch-recover
hra plugin list <account> [--project <project>] [--refresh]
hra plugin show <account> <plugin> [--project <project>] [--refresh]
hra project add --path <directory> [--name <name>]
hra project list
hra project use <project>
hra session list [--account <profile>] [--archived] [--limit <1..100>] [--cursor <cursor>]
hra session adoption status [--provider <codex|claude>]
hra session adoption enable <account> --provider <codex|claude>
hra session adoption disable --provider <codex|claude>
hra session discover [--provider <codex|claude>]
hra session show <session> [--detail]
hra session status <session> [--json]
hra session watch <session> [--cursor <cursor>] [--jsonl]
hra session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]
hra session interactions <session> [--pending] [--limit <1..100>] [--cursor <cursor>]
hra memory status <session> [--json]
hra memory list <session> [--working-only] [--continuation <token>] [--json]
hra memory get <session> <key> [--working-only] [--continuation <token>] [--json]
hra memory search <session> [--working-only] [--continuation <token>] <text> [--json]
hra memory explain <session> <query-id> <row> [--json]
hra memory remember <session> <key> --title <title> --summary <summary> [--language <tag>] [--idempotency-key <uuid>] [--json] -- <body>
hra memory share <session> <key> --reason <reason> [--idempotency-key <uuid>] [--json]
hra memory hosted list [--json]
hra memory hosted create <project> [--idempotency-key <uuid>] [--json]
hra memory hosted attach <project> <hosted-space-id> [--json]
hra memory hosted detach <project> --generation <n> [--json]
hra memory hosted sync <project> [--json]
hra session start <account> [--project <project>] [--provider <codex|claude>] [--preset <low|high|ultra|fable-max>] [--fast] [--idempotency-key <uuid> [--preset-contract <1|2>]]
hra session send|queue|steer <session> [--attach <path>]... <message>
hra session stop|recover|abandon <session>
hra session rename <session> <name>
hra session archive|unarchive <session>
hra session note get|edit|clear <session>
hra session note set <session> <note>
hra session state <session> [--json]
hra session peer-policy get <session> [--json]
hra session peer-policy set <session> <off|inspect|coordinate> --revision <n> [--json]
hra session preset <session> <low|high|ultra|fable-max>
hra session switch <session> --provider <codex|claude> [--preset <low|high|ultra|fable-max>] [--account <account>] [--idempotency-key <uuid> [--preset-contract <1|2>]]
hra session export <session> [--format <trajectory|json>] [--out <path>]
hra session fast <session> <on|off>
hra session project <session> <project>
hra session switch <session> --provider <codex|claude> [--preset <low|high|ultra|fable-max>] [--account <account>]
hra session export <session> [--format <trajectory|json>] [--out <path>]
hra session task list <session>
hra session task show <session> <task-id>
hra session task create <session> --name <name> --every-minutes <15..10080> [--paused] [--idempotency-key <uuid>] -- <prompt>
hra session task edit <session> <task-id> --revision <n> [--name <name>] [--every-minutes <15..10080>] [--pause|--resume] [--idempotency-key <uuid>] [-- <replacement-prompt>]
hra session task delete <session> <task-id> --revision <n> [--idempotency-key <uuid>]
hra work protocol [--operation <kind>|--type <name>|--topic <topic>]
hra work apply --input-stdin|--input-fd <fd>
hra work snapshot <work> [--actor <session>]
hra work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]
hra work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1..50>] [--wait-ms <0..30000>]
hra work events <work> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]
hra work watch <work> [--cursor <cursor>]
hra interaction list [session] [--pending] [--limit <1..100>] [--cursor <cursor>]
hra interaction show <interaction-id>
hra interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]
hra interaction decide <interaction-id> --revision <n> --decision <once|session|decline|cancel>
hra interaction grant|answer <interaction-id> --revision <n> --input-stdin|--input-fd <fd>
hra interaction submit <interaction-id> --revision <n> --action <accept|decline|cancel> [--input-stdin|--input-fd <fd>]
hra autorespond on|workspace|off|default|status [--session <session>] [--json]
hra autorespond gateway set [--from-fd <fd>] [--json]
hra autorespond gateway clear [--json]
hra autorespond-after-hours status [--json]
hra autorespond-after-hours enable|disable --revision <n> [--json]
hra remote list [--limit <1..100>]
hra remote show <cloud-session>
hra remote command <uuidv7>
hra remote send|queue|steer <cloud-session> <message>
hra remote send --or-steer <cloud-session> <message>
hra remote resolve <cloud-session> --interaction <uuid> --revision <n> --decision <decline>
hra remote stop <cloud-session>
hra remote preset <cloud-session> <low|high|ultra|fable-max>
hra remote provider <cloud-session> <codex|claude> [--preset <low|high|ultra|fable-max>]
hra remote fast <cloud-session> <on|off>
hra remote allow|deny <device-commands|account-linking>
hra remote policy
hra turn inspect <session> <turn> [--json]
hra sync status|now
hra sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]
hra daemon start [--json]
hra daemon status|stop [--json]
hra daemon run
```

Account, project, and local-session selectors accept an exact ID or an unambiguous case-insensitive label. Cloud-session selectors accept an exact public ID, a unique public-ID prefix, or an exact synced name. Device selectors accept an exact ID or unique prefix. Ambiguity lists candidates and performs no effect. The CLI creates and sends an idempotency key before every provider effect; pass `--idempotency-key <uuid>` to reuse one after a lost response. If a local mutation response is uncertain, HRA returns the generated key and the exact replay arguments without repeating the command payload. Put those arguments before any `--` delimiter when rerunning the otherwise unchanged command. A source-sensitive Codex `session start` or provider-switch replay includes both `--idempotency-key` and its immutable `--preset-contract`; do not omit or change either after an update. The preset-contract option is a source-binding field that requires an explicit idempotency key and is rejected for stable requests. With an existing key, a source-matched applied request replays its result and an effect-started request remains recovery-required. With a key that has no stored row, only this build's active source contract may authorize the one fresh effect; the field cannot select a retired route.

An older session-start release did not print the source contract, so its exact historical alias meaning must be supplied explicitly when replaying its key. For a v0.5.0 Codex start that omitted the then-default preset, preserve every other original option and add `--preset high --preset-contract 1`; v0.5.0 High and Ultra both meant Sol. Use `--preset-contract 2` only for an untagged Astra-era request whose original runtime evidence actually meant Astra. Neither selector can resume a contractless prepared row. Contract 2 cannot authorize a fresh effect under the current Sol binding; contract 1 can authorize the exact Sol request when the key has no stored row, just as a newly generated key can. If the originating meaning cannot be proved, use the retained old release rather than guessing. A contractless prepared row has no supported cancellation or retirement command. It must reach a terminal settlement through exact replay under the originating release, or the update remains blocked. Do not use a fresh key or `session abandon` as a workaround; that command applies only to an existing recovery-required session and never cancels prepared start or switch authority. `session preset` has no idempotency-key replay; resolve and inspect it before updating. session recover accepts only exact, kind-specific provider proof. session abandon never retries or deletes provider state and releases only the local recovery authority. Remote mutations require a current UUIDv7 when this option is supplied. With `--json`, stdout contains one versioned object; diagnostics stay on stderr.

`interaction show` lists each safe requested permission category and each exact question ID. Complete live command and permission authority is available only through the revision-bound protected `interaction inspect` path described above. A permission grant reads `{"permissions":["<requested-name>"]}` and a question response reads `{"answers":{"<question-id>":{"answers":["<answer>"]}}}` through protected input. Those permission-name and question-answer document shapes are Codex-specific. The live Codex adapter rehydrates selected permission names to their exact private provider values immediately before the response write; those values never enter display, storage, logs, or sync. Claude Code tool-use requests map to HRA's provider-neutral interaction kinds and accept only the response choices that exact callback offers.

Every admitted callback carries a local deadline anchored when the provider delivered it. HRA caps the pending interval at 30 minutes and honors a shorter valid provider interval, including an immediate zero interval. At the deadline it writes one provider-neutral timeout error through the same write-ahead ledger, never invents an answer or grant, and quarantines the provider generation if the write may have escaped. `interaction show` displays the safe local deadline; nested remote policy version 2 carries the same absolute deadline so readers can suppress an expired control, while the daemon remains authoritative.

For a standard MCP form, interaction show returns the exact public field contract without defaults or answers. Accept reads one protected document shaped as `{"content":{...}}` from nonterminal stdin or a file descriptor. Decline and cancel accept no content. JSON mode never prompts, and validation failures identify the contract failure without echoing a submitted value.

Projection recovery uses the local-session selector rules. It requires `--acknowledge-gap` and a canonical UUIDv7; the CLI generates a current key when it is omitted. A stored exact key remains the only admissible replay while recovery is unsettled. Inside the seven-day window, a prepared replay renews its lease and can apply. After the window, replay reconciles immutable committed lineage or safely settles known-no-effect authority as rejected; status then determines whether to retry with a fresh generated key.

The beta does not expose destructive local profile or project deletion. `account logout` asks Codex app-server to remove that profile's Codex login while HRA preserves its local session history. HRA does not implement Claude Code sign-out; use Claude Code's own authentication flow inside the isolated profile.

## Authority boundaries

Codex app-server and Claude Code remain authoritative for their provider-native authentication, sessions, execution, tools, approvals, models, and hidden runtime state; Codex additionally owns its plugin, usage, and native transcript surfaces. HRA owns isolated profiles, the durable provider-neutral conversation record and commands, process generations, local projections, optional encrypted sync, and recovery records. The frozen work contract assigns local coordination records to HRA rather than either provider runtime.

Cloud service availability is not required for local provider authentication, local execution, local work coordination, local recovery, or reading local sessions. Provider accounts remain independent subscriptions. HRA does not pool quota or replay a limited turn under another account or provider. The separately adopted provider-usage contract permits bounded managed Codex movement only under fresh local authority; explicit sessions, work tasks, Claude accounts, and cross-machine execution remain outside that boundary. SQLite remains the local work execution authority; Turso is deferred and non-authoritative.

## Project

HRA is MIT licensed. Read the [security policy](https://github.com/hraness/hra/blob/main/SECURITY.md) before reporting a vulnerability, use [private vulnerability reporting](https://github.com/hraness/hra/security/advisories/new) for suspected security issues, and read the [contribution guide](https://github.com/hraness/hra/blob/main/CONTRIBUTING.md) before a large change.
