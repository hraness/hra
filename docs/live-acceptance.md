# Live acceptance

The release gate uses two complete HRA daemon installations. It does not simulate a second device with two cloud-control objects, replace `HOME`, create temporary macOS users, or write acceptance credentials to Keychain.

This harness is repository-only. It lives under `scripts/`, is excluded from the npm package, and does not add a state-root, socket, capability, or alternate-installation option to the production CLI.

## Isolation

`startLiveAcceptanceRun()` creates one canonical mode-`0700` run directory below the canonical operating-system temporary directory. It creates four distinct direct children:

- one state root for device A;
- one state root for device B;
- one project directory for device A;
- one project directory for device B.

Every child is a canonical mode-`0700` directory owned by the invoking user. The harness records the device and inode of each directory before it starts either worker. It refuses any run directory that overlaps the production HRA state root or the invoking home in either direction.

Each worker receives one strict descriptor through inherited nonterminal file descriptor 3. The descriptor is bounded to 8 KiB and contains the run ID, device name, state root, project directory, exact expected `HOME`, and optional cloud deployment URL. These values never appear in worker arguments or environment variables. The worker arguments contain only the fixed source-worker path.

File descriptor 4 carries bounded CLI invocations, protected input documents, and internal cleanup commands. It also owns the worker lifetime. Every scenario operation enters the exported HRA `main()` function, passes through the production parser and renderer, and reaches the daemon through the ordinary local transport. A protected command must select `--input-fd 4`; the worker proves that descriptor is nonterminal, consumes exactly one paired document, and rejects stdin, another descriptor, an unused document, `--follow`, and daemon lifecycle commands. Parent death aborts an in-flight local request immediately, closes the queue, and requests bounded daemon shutdown. File descriptor 5 carries bounded typed CLI results and lifecycle acknowledgements. Worker stdout and stderr are closed, so provider output, credentials, paths, and diagnostics cannot escape through process output.

Each worker supervises sequential full daemon generations. A successful auth completion or account-deletion response that declares `daemonRestartRequired` is delivered first, then the worker waits for complete authority release and starts a new generation before accepting another operation. An unexpected daemon completion after readiness is terminal. Device suspend and resume stop and start a full generation while preserving the worker control process, which allows the scenario to cross the hosted presence boundary without a second state authority.

Both installations preserve the invoking `HOME` byte for byte. Each account still receives its ordinary isolated `CODEX_HOME`. Acceptance `CODEX_HOME` directories contain this exact configuration:

```toml
cli_auth_credentials_store = "file"
mcp_oauth_credentials_store = "file"
```

The daemon proves both effective values through the pinned Codex `config/read` preflight before login or plugin discovery. It assigns a distinct private `TMPDIR` below each `CODEX_HOME`. HRA secret custody uses `FileSecretBackend` below the corresponding state root. The acceptance composition cannot construct the production `BunSecretBackend`, and it disables desktop switching.

Before the daemon starts, each worker changes its process working directory to its verified isolated project. Codex therefore loads its account-level credential policy from the same project boundary used by the effective `config/read` checks. The repository checkout and another device's project cannot contribute a startup project layer.

## Operator driver

The executable is the release gate. It requires the explicit canonical origin to equal the candidate authority compiled into this checkout. Loopback, a different HTTPS deployment, an omitted value, and a noncanonical spelling all fail before either worker starts. Put this non-secret configuration in a mode-`0600` file:

```json
{"cloudDeploymentUrl":"https://qualified-hummingbird-537.convex.cloud","operator":{"kind":"terminal"},"version":1}
```

Run the complete scenario with that document on a nonterminal descriptor:

```sh
bun run acceptance:live --scenario-fd 3 3< /protected/path/to/live-acceptance.json
```

Terminal mode hides every invite, OTP, auth document, interaction answer, and permission grant. Before rendering provider-controlled login handoff values, it requires an HTTPS URL without credentials or terminal-control scalars and a short uppercase alphanumeric device code. It then waits for the human to acknowledge provider completion. The process prints safe progress to stderr and exactly one final JSON value to stdout. Exit `0` means the full scenario and cleanup passed. It does not mean that two daemons merely became ready.

The gate also requires a clean Git worktree and resolves the exact `HEAD` commit before starting workers. Passing evidence binds the SHA-256 digest of the configured cloud origin, the package version, and the 40-character source revision. This makes a result from a local fake, a different deployment, a dirty checkout, or a different source revision distinguishable from the intended release candidate.

Agent runners can select `{"operator":{"kind":"jsonl"}}`. In that mode fixed inherited streaming IPC descriptor 5 emits bounded requests and fixed inherited streaming IPC descriptor 4 accepts one matching response at a time. Requests carry a UUID and one of `protected_input_required`, `device_login_required`, or `progress`. Responses must echo the UUID and be exactly one of:

```json
{"document":{"email":"person@example.com"},"requestId":"00000000-0000-4000-8000-000000000000","type":"protected_input","version":1}
{"acknowledged":true,"requestId":"00000000-0000-4000-8000-000000000000","type":"device_login","version":1}
```

The candidate configuration descriptor cannot reuse descriptor 4 or 5. A closed operator input, an unexpected response type or UUID, a terminal descriptor, an oversized frame, or extra fields fails closed and retains recovery state. `SIGINT` and `SIGTERM` abort protected reads, device calls, polls, presence sleeps, and cleanup waits. Preservation joins any in-flight cleanup before it writes a recovery state, so cleanup and interruption cannot race receipt deletion or overwrite each other's checkpoint.

The source API remains available for deterministic tests and recovery tooling. `run.device("a")` exposes only the verified project directory, bounded CLI `execute()`, and daemon-generation `suspend()` and `resume()`. It does not expose arbitrary state paths, sockets, capabilities, cloud controls, or a public `LocalCommand` transport.

## Release scenario

The executable performs these checks itself. Use two distinct real Codex subscriptions. Reusing one subscription under two labels fails the provider-identity proof.

1. Consume the one-time HRA identity invite on device A through protected auth input. Complete the email code flow and prove that A becomes the first active keyed device.
2. Add and complete Codex login for two accounts on A. Prove distinct provider identities, isolated `CODEX_HOME` directories, and one exact `observed` usage poll and snapshot bound to each account ID and source revision.
3. Authenticate device B to the same HRA identity. The harness compares an ephemeral in-memory digest of the canonical email in A's invite and code documents with B's email and code documents before each later auth effect; it never persists or emits that digest. Prove that B registers as pending, cannot sync or read encrypted projections, and cannot submit a remote command.
4. Approve B from A, pair B, and prove that B receives the workspace key without receiving A's device credential.
5. Start one session under each Codex account. Use unique non-secret markers. Follow each exact account, session, and turn while active. Prove one uninterrupted provider authority, ordered cursor pages without gaps or terminal errors, a safe reasoning summary, an assistant delta containing the exact marker, and terminal completion.
6. Exercise one `request_user_input` interaction and one permission-request interaction before `/bin/echo hra-live-tool-progress`. Discover each as pending and blocking under the exact session and turn. Resolve it by exact ID and revision through protected input, require the CLI's advanced `response_written` interaction with `responseRecorded: true`, and prove the same interaction's requested, response-prepared, and response-written events occur inside the turn boundary under one provider authority. Bind command start, nonempty output progress, and completed command execution to the same item and turn. Run a bounded, path-free plugin discovery for the exact account, then prove `auth`, `disable`, `enable`, and `install` all receive the exact production-parser `INVALID_INPUT` result and exit code 2.
7. Sync from both devices. Prove that B reads A's assistant marker, receives a pending receipt for an exactly bound `send` command to the A-custodied session, and observes its terminal `applied` status. Then repeatedly sync and pull the exact complete, gap-free A projection until the submitted turn has both the expected assistant marker and its terminal turn summary. The gate does not require sampling the transient `effect_started` state.
8. Prove device presence transitions across a daemon stop, the 45-second offline boundary, and restart. Revoke B from A. Prove exact `UNAVAILABLE` denial for sync, the exact remote session read, and a new remote send. After another presence boundary, prove A sees that exact B device as revoked and offline.
9. Call `run.cleanup()`. Do not remove either local root manually.

The scenario fails if it does not observe an active polling interval, continuous ordered progress, a reasoning-summary event, same-item tool start/progress/completion, assistant output for both local turns, both exact interactions, terminal turn settlement, pending and applied remote states, a terminal remote assistant result, or any presence and revocation boundary. It compares the two provider identities only in memory and exports the boolean `providerIdentitiesDistinct: true`; it does not export email hashes or other linkable provider commitments. Final evidence otherwise contains only non-secret IDs, timestamps, event-kind sets, marker digests, state transitions, target digest, source revision, package version, and pass outcomes. It never contains provider credentials, emails, invites, OTPs, device codes, raw reasoning, arbitrary tool output, local paths, environment values, socket capabilities, or encrypted workspace keys.

## Cleanup

`run.cleanup()` advances a durable checkpoint only after it proves each boundary:

1. If no HRA identity was created, both installations must prove that no local cloud device exists and cloud deletion is skipped. If A is signed in but B has not registered, B must prove the same canonical email and no device. If B registration committed across a lost response before its public ID reached the receipt, recovery compares B's own signed-in device ID and status with A's sole noncurrent peer, durably records that exact public ID and a stable revocation idempotency key, and only then revokes it. A previously bound pending or active B is revoked with the same key; an already revoked B is re-proved. Any different active or pending peer, mismatched identity, ambiguous device row, or unrelated historical revoked row blocks cleanup.
2. Cloud account deletion reaches fresh terminal `complete` status with effects disabled. A second `auth.status` read proves the same state.
3. Every Codex account on both devices completes logout. If a prior logout response was lost, recovery first runs the required exact `account show` reconciliation and issues no new logout unless that read proves the provider remains signed in. A new account-list read proves no profile remains signed in, login-pending, or recovery-required.
4. Both daemon workers stop. Each child exits successfully, releases its daemon authority with a `stopped` receipt, and removes its socket and capability.
5. The invoking `HOME` is still the exact original value.
6. Every recorded directory still has its original owner, mode, device, inode, canonical location, direct-child relationship, role prefix, and run ID.

Only then does cleanup assign a random quarantine name inside the owned run directory, atomically rename one direct child, recheck its inode, recursively remove it, and advance the receipt. It repeats this for all four children, removes the empty run directory, then removes the receipt.

Any failure closes the worker control pipes, preserves the roots, and writes a mode-`0600` recovery receipt beside the run directory. The receipt records the last completed checkpoint, any exact B identity and revocation key learned before failure, the cloud-cleanup mode, and each planned or completed quarantine transition. It contains paths and process IDs but no credentials or bearer capabilities.

## Recovery

Wait until every recorded worker PID has exited. Pass the complete receipt through a nonterminal descriptor:

```sh
bun scripts/live-acceptance.ts --resume-fd 3 3< /protected/path/to/recovery-receipt.json
```

The only argument is the descriptor number. The state root, socket, capability, and receipt contents do not enter argv or the environment.

Recovery treats the mode-`0600` file on disk as authoritative. The caller-provided document is only a protected locator. Recovery opens the exact file without following links, verifies its owner, link count, mode, size, device, and inode before and after the bounded read, and parses the on-disk document. It rejects substituted caller fields.

It then revalidates the run-ID filename, receipt location, run-root prefix, all four distinct role paths and prefixes, directory identities, canonical temporary parent, and non-overlap with production HRA state and the invoking home. A live PID, stale socket, changed inode, symlink, unknown direct child, incomplete cloud erasure, incomplete Codex logout, or failed shutdown proof leaves the receipt and roots intact.

If cleanup stopped before daemon shutdown, recovery starts two new attached workers against the same isolated installations and converges from no auth, partial same-identity auth, a lost B registration response, or a bound pending, active, or revoked B before continuing from the last safe cloud or logout checkpoint. If daemon shutdown was already proved, recovery resumes only the recorded quarantine transitions. A crash after a rename or removal is reconciled from the original and planned quarantine paths before any next deletion.

## Deterministic evidence

The suite proves strict descriptor parsing, exact candidate selection, canonical private roots, unchanged `HOME`, distinct state and temporary paths, file-only HRA and Codex custody, disabled desktop switching, absence of state authority in worker argv and environment, real CLI and protected-input routing, full-generation suspend/resume, symlink refusal, lost-pair derivation, exact-peer revocation, ambiguous-logout reconciliation, gated quarantine deletion, authoritative on-disk recovery, checkpoint resumption, serialized cleanup interruption, and a real two-subprocess smoke in which both full daemons become ready and stop with released authority and absent socket and capability endpoints. The scenario test drives every release step through a deterministic two-device world, rejects prompt-only result markers, empty usage, local event gaps, wrong remote projection authority, incomplete remote turns, mismatched interaction receipts, mismatched B identity, and terminal-unsafe login handoffs. A real subprocess regression keeps the JSONL input descriptor open, aborts the read, and proves the child exits. Final evidence omits provider identity values, provider-derived hashes, and device-code values.

```sh
bun test scripts/live-acceptance.test.ts scripts/live-acceptance-scenario.test.ts
```
