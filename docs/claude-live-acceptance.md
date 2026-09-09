# Claude live acceptance

The optional repository-only Claude qualification proves one fresh managed HRA session can use working memory through the pinned Claude MCP bridge. It is not a prerequisite for tagging or publishing HRA artifacts under the [machine-gated release policy](beta-release.md). It is separate from the [two-device Codex and hosted-memory qualification](live-acceptance.md). Neither proof substitutes for the other, and deterministic tests do not substitute for an authenticated live run.

## Before running

Use an authorized Linux host with HRA's supported native process-authority backend, Bun 1.3.14, and exact Claude Code 2.1.260. The invoking standard input, output, and error must be real terminals. Use a clean checkout of the candidate being qualified.

Reserve an authorized disposable Claude login and permission for one bounded paid test turn. The gate creates a new isolated HRA profile and project; it does not adopt a personal conversation, copy a credential store, change `HOME`, rotate accounts, or delete a hosted HRA identity. Native login requires the human operator. Do not run it against credentials the operator has not authorized for this test.

Before login, the gate checks the exact runtime and probes its native logout help against the reviewed command and option vocabulary. An unsupported runtime or logout surface refuses before authentication. Synthetic help fixtures are parser tests, not a captured proof of the installed binary.

## Run the proof

Choose a new evidence path in a canonical, invoking-user-owned mode-`0700` directory:

```sh
bun run acceptance:live:claude \
  --evidence-path /protected/release/claude-live.json
```

Alternatively, `--evidence-fd 3` selects an already opened protected nonterminal descriptor. Do not combine it with `--evidence-path`. Neither form accepts caller-selected provider, model, state root, socket, or capability arguments. The source revision, package version, and fixed target binding come from the checkout.

The gate performs these boundaries in order:

1. Create canonical private test directories and a durable recovery receipt. Spawn an inactive isolated worker, record its exact PID, then deliver the installation descriptor that permits daemon startup.
2. Add the test profile and complete Claude's production foreground login flow. Interruption must join that flow before daemon shutdown begins.
3. Start one fresh `fable-max` session with its HRA capability binding, then send one nonce-bound memory task. Approve only the exact memory-remember MCP request for that turn. Any additional or different tool request prevents passing evidence.
4. Capture the actual attributed host call and response-written acknowledgement. Corroborate native start and send receipts before public ID masking. Require the same-turn assistant to consume the unpredictable committed memory receipt, not merely repeat a marker from the prompt.
5. Independently read the retained native mutation and memory records, owner working-memory query and status, exact private bridge configuration, and live process identity and arguments. The sole-submission check covers retained rows, not an unbounded historical claim.
6. Stop and join the complete daemon generation. Prove the exact process is released and no longer live, and that its bridge binding, configuration, capability, and socket are absent. `session.stop` alone is not this proof.
7. Perform isolated native logout, verify signed-out status, and remove only the inode-verified test directories through the recorded quarantine transitions. Write passing evidence only after cleanup succeeds.

The evidence contains bounded digests and pass predicates, not credentials, provider output, memory text, raw provider identifiers, environment values, private state paths, or bearer capabilities. It proves the observed tool and memory boundary, not cognitive use of every preamble instruction, hostile same-user isolation, or remote provider credential erasure.

## Interrupted or failed runs

Retain the reported private recovery receipt. A failed proof may still need native sign-out; cleanup must not depend on having a passing memory receipt.

```sh
bun scripts/claude-live-acceptance.ts \
  --resume-fd 3 3< /protected/path/to/claude-recovery.json
```

Resume is cleanup-only. It does not log in again, start another paid turn, repeat an uncertain memory call, or produce passing evidence. Open the current named recovery receipt itself, not a saved copy; the descriptor must still refer to that exact file. The authoritative mode-`0600` on-disk receipt binds the candidate, run, profile, directory identities, completed preflight, and any attempted logout.

Before any logout or deletion, recovery must prove daemon shutdown and the relevant native process custody. A dead worker PID alone is insufficient. Unreleased authority, a live or unidentifiable process, an unsettled foreground operation, changed directory identity, or unknown run child preserves the receipt and roots for explicit custody recovery.

A crash during worker activation can leave a recorded PID without an authoritative stopped-daemon receipt. Even if that child never initialized a daemon, ordinary resume preserves this uncertain startup state; it does not infer deletion authority from missing files or a dead PID. The pre-activation PID record is not a promise that every startup interruption is automatically recoverable.

If session creation committed before its ID reached the recovery receipt, resume reads the exact recorded start idempotency key and requires the original managed-session, project, runtime, and process-generation bindings. It never repeats the start. After shutdown and sign-out are proved, a durable cleanup authorization permits later resume to finish recorded quarantine transitions without reopening already removed runtime or credential files. That authorization cannot create passing acceptance evidence.

Logout is status-first and its attempt is recorded before dispatch. If a previous attempt has an uncertain outcome, resume only checks whether that exact isolated profile is signed out; it does not issue another logout speculatively. No signed-out proof means no credential-root deletion.

Do not delete recovery journals, kill unrelated processes, replace the receipt, or recursively remove a path merely because it resembles a test prefix.

## Validation boundary

Focused tests cover the typed capture, independent readback, process framing, private receipts, native logout state machine, and runner failure paths without using real credentials. Run process-custody checks through the repository's required host scheduler. Artifact release still requires the fresh exact-tree aggregate and the protected release workflow's machine-enforced checks. This authorized Linux proof remains optional qualification with unchanged provider, platform and cleanup requirements. A local helper test, successful installation or artifact admission does not establish authenticated qualification; an incomplete run must remain reported as incomplete.
