# Hosted sync deployment

Hosted operations run the official Convex CLI as an ordinary bounded child process and work from macOS or Linux with only Bun and an authenticated Convex CLI session. The Linux-only authority supervisor requirement and the separate authorization phrase were retired on 2026-09-03 by the owner's decision to run hosted sync as a beta; every identity guard, readback proof, and denylist below still applies. DNS records, domain assignments, and the production alias are separate procedures (see `docs/domain-cutover.md`). This runbook targets current HRA only. The retired HRA v0 Vercel and Convex resources are not fallback or rollback authorities.

Use this sequence only in the existing current HRA Convex project. A recovery creates one distinct, non-default production deployment in that project; it never creates a replacement project. The setup helper refuses an existing HRA environment by default and does not support overwrite.

Never copy retired HRA v0 data, deployment URLs, deploy keys, authentication keys, HMAC material, Resend credentials, environment values, or backups into the current project. Do not recreate or select a retired resource.

The provider identity guard pins the intended Convex team to numeric ID `513923` and provider slug `cclrte`. Retired HRA v0 Convex project ID `2680173` and production deployment ID `4677913` remain permanent denylisted safety tombstones; neither may be recreated, renamed into, or selected by this runbook. The current source repository has GitHub repository ID `1343008607`, and the current web project has Vercel project ID `prj_8ciIt9t9foE3utG45frRN7cxckjS`. Provider names may change. The team identity and numeric resource IDs do not.

Live projection. Besides the compact stream of completed turns, the daemon streams the current turn's assistant text (and reasoning summaries only when show-thinking is enabled for the session, default off) to the `detail` stream about once per second in redacted, encrypted batches of at most 8 KiB. Detail chunks carry the `live_tail` retention class: each row expires six hours after it is written, a session keeps at most 200 rows, and the `live_tail_chunks` maintenance category sweeps expired rows behind a detail stream epoch so digest-chain verification of the surviving tail stays valid and both the chunk quota and the per-user `live_chunk` resource counter are released. Raw reasoning is never uploaded.

Push wake and sync cadence. Besides its poll timer, the daemon holds one websocket subscription to the pending commands addressed to its own device, presenting the same bearer token from the same custody slot as the HTTP transport and refusing under the same deployment fence. A change to that set wakes the sync cycle immediately, so steering, approvals, and decisions from another device apply in well under a second instead of waiting out the interval. The subscription carries no authority: every command it announces is still claimed, bound to the exact authority generation, and settled by the ordinary cycle under its idempotency key, so a wake that races the timer costs one extra cycle and never a second execution. When the socket fails, one diagnostic is reported through the ordinary cycle diagnostics that `hra sync now` prints, the daemon falls back to polling, and it reconnects with a doubling backoff from one second capped at thirty. The timer itself is adaptive: one second while another device is present in presence or a local session is mid-turn, fifteen seconds otherwise. The device-presence probe is cached for ten seconds so the fast cadence does not list devices every second. `hra sync status` reports the current interval, why it was chosen, and the push-wake state.

Each Convex CLI invocation is bounded in runtime and output and receives only an allowlisted child environment. A timeout reports exit 124 and an output overflow reports exit 1; both are ordinary command failures that the helpers classify without a provider retry. Hosted bootstrap and invitation results retain the protected invite file after capability commit, and attested deploy results retain the final evidence path and its `.intent`. Durable intents and receipts, provider idempotency, and exact reconciliation remain mandatory for every ambiguous Convex result; no local custody claim proves that a remote effect did not occur.

## Migrate staged prerelease secret pointers

This compatibility operator is only for repository checkouts that ran an unpublished prerelease HRA v1 build on macOS when the default secret backend was Keychain. No HRA v1 beta containing that default was published. This command is therefore a repository-operator migration for staged prerelease state, not an installed-product feature, a daemon fallback, or a reason to make the daemon read Keychain.

Run the read-only inspection from the exact source checkout first:

```sh
bun run operator:migrate-legacy-secrets preflight
```

Preflight reads the private pointer metadata and current `secret-values` files only. It does not acquire daemon authority, create a directory or file, read Keychain, copy a value, delete an entry, or perform another mutation. `ready` with `nextAction: "execute_migration"` means at least one current pointer still lacks its exact file-backed value. `already_complete` and `not_required` need no migration. Unsafe, unknown, locked, malformed, non-owned, multiply linked, permission-inexact, oversized, replaced, or digest-conflicting metadata is a refusal. Output contains counts and a closed status only. It never contains a secret value, digest, slot, Keychain account, nonce, or local path.

Stop every HRA process, then run the explicit foreground mutation:

```sh
bun run operator:migrate-legacy-secrets --execute
```

Execution first acquires and holds HRA's exact daemon lifecycle authority in maintenance state. A live or starting daemon causes `daemon_running` before any Keychain access. While that authority remains held, the operator re-reads every current pointer, reads only missing values from Bun's legacy `sh.hra.control-plane.v1` service, checks each value against the pointer digest, and validates all missing values before copying any. It publishes each value at the unchanged immutable account name through the current `FileSecretBackend`, then reopens every required file through the protected descriptor boundary and proves all pointer digests again before releasing authority and reporting success.

The operation is safe to replay after a crash or refusal. Exact copies are accepted without another Keychain read, missing copies resume, and an existing conflicting or unsafe file stops the run without overwrite. A pointer change during execution is a refusal even when an earlier copy succeeded; stop HRA and replay so the current complete pointer set can be proved. The operator never deletes or changes an entry in the legacy Keychain service. Keep those entries as recovery evidence until the prerelease installation is no longer needed, then review any manual cleanup separately.

## Replace a quarantined current target

Use this exceptional preproduction recovery path only after the exact `approve both` authorization and only when the current default production deployment is unsuitable for bootstrap. It stays inside the current project and never reads, selects, imports, recreates, or modifies a retired v0 resource.

Log in with the Convex CLI first. Its global `config.json` must be a regular, single-link, mode-`0600` file. Do not supply a deploy key or deployment selector through an environment variable, `.env`, or `.env.local`. Choose one UUIDv7 replacement ID and one unused absolute evidence path whose existing parent is an invoking-user-owned mode-`0700` directory. Both values remain fixed across the whole transaction.

Create and receipt one distinct non-default production target from the exact current-default tuple:

```sh
bun run hosted:replace-target -- create --execute \
  --replacement-id <UUIDV7> \
  --evidence-path /protected/release/convex-replacement.json \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

The operator first proves that supplied tuple is the current default, writes a protected create intent and dispatch receipt, creates only a production deployment with a unique `hra-replace-…` reference and `isDefault: false`, then reads the reference, new target, and old default back. It emits one closed JSON record. A `created_receipted` result means the new target is distinct and non-default while the supplied target remains default; record only the returned target tuple in the private release record.

Read durable replacement state with the same tuple, replacement ID, and evidence path:

```sh
bun run hosted:replace-target -- status \
  --replacement-id <UUIDV7> \
  --evidence-path /protected/release/convex-replacement.json \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

For `created_receipted`, `demoted_receipted`, and `complete`, status performs the corresponding authority-contained remote read before reporting that state. Other intent or dispatched states describe protected local evidence only and make no remote success claim. A `*_dispatched_reconciliation_required` result must be resumed with the same `create --execute` or `switch --execute` command, never with a new replacement ID or evidence path. The operator reconciles the recorded phase before any recorded successor mutation.

After the create receipt is current, switch the project default with the same values:

```sh
bun run hosted:replace-target -- switch --execute \
  --replacement-id <UUIDV7> \
  --evidence-path /protected/release/convex-replacement.json \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

Convex requires the former default to be demoted before another production deployment can be promoted. The operator persists separate demote and promote dispatches, verifies the deliberate no-default intermediate state, and then promotes the replacement. It never promotes after an indeterminate demotion and never demotes again after an indeterminate promotion; a resumed switch reconciles the recorded phase first. Do not run deploy, configure, bootstrap, invitations, a DNS change, or an alias change while the project has no default. `complete` is emitted only after the replacement is read back as default and the former target as non-default.

This changes Convex default selection only. It does not change HRA's checked source target, release evidence, site environment, user deployment custody, DNS, domain assignment, or production alias. Bind the returned target tuple into a separately reviewed source release before treating it as HRA's hosted-sync endpoint.

## Create fresh state

Record the exact clean 40-character lowercase Git commit. Deploy that source before any authentication or invitation write. Substitute the verified current target tuple and exact commit below:

```sh
bun run hosted:deploy -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --source-commit 0123456789abcdef0123456789abcdef01234567
```

The helper requires `HEAD` to equal that commit and the entire checkout, including untracked files, to be clean before and after deployment. It refuses any caller team ID except `513923`, then reads the authenticated Convex management API before and after the mutation and requires team slug `cclrte`, team ID `513923`, the exact project, deployment, production type, generated deployment name, URL, and two matching default-production facts: the deployment reports `isDefault: true` and the project names that deployment as `prodDeploymentName`. It rejects selectors such as `prod`, `local`, and `team:project:prod`, and rejects the retired HRA v0 numeric IDs.

The helper creates a private exclusive environment file containing only `CONVEX_DEPLOYMENT=prod:<generated-name>`. Convex uses that value as project context and deploys to the project's current default production deployment, so the matching default-production readbacks are part of the target guard rather than an informational check. After Convex resolves the actual deployment credentials and before it pushes, its mandatory `--cmd` exposes the resolved canonical cloud URL only to a silent local assertion. That assertion must match the exact expected deployment URL or the deploy stops before `runPush`; a later default change cannot redirect the already-resolved credentials. The helper disables Convex's optional pre-command WorkOS provisioning because HRA does not use Convex AuthKit and no provider mutation may precede this assertion. It otherwise invokes `convex deploy --env-file` with confirmation disabled, strict typechecking, code generation disabled, sanitized inherited environment variables, bounded provider output, and a ten-minute deadline. Provider output is suppressed. A failure, changed default, resolved-target mismatch, or dirty postflight leaves the deployment quarantined for inspection; do not retry it.

## Release deployment evidence

The ordinary first deployment above installs the tracked `releaseAttestation:read` query in its explicit unbound state. The query exposes only schema identity and binding state. It contains no credential, provider response, deployment selector, or secret. A transport failure, missing function, malformed response, or timed-out query is ambiguous and never counts as an unbound runtime.

Create release evidence only from a clean detached worktree at the exact source commit. The evidence directory must be canonical, invoking-user-owned, and mode `0700`; each output path must not name a symlink or unsafe existing file. Bind the first release deployment as the bootstrap phase:

```sh
bun run hosted:deploy -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --source-commit <BOOTSTRAP_COMMIT> \
  --phase bootstrap \
  --evidence-path /protected/release/bootstrap-deploy.json
```

The bootstrap pre-read must positively return the tracked unbound attestation. HRA records a protected intent before deployment. It creates a private temporary tree with `git archive` from the exact clean commit and refuses an archive that already contains `node_modules`, a symlink in any package, assertion, or CLI ancestor, or an unsafe lockfile. Inside that tree, the pinned Bun 1.3.14 runtime runs `install --frozen-lockfile --ignore-scripts --backend=copyfile` under bounded local-process custody. The explicit copyfile backend prevents installed package bytes from sharing hard links with Bun's cache or another dependency tree. The install must finish successfully, leave `bun.lock` and `package.json` byte-identical, and produce a local Convex CLI beneath the private source root. HRA captures type, device, inode, and link-count identities for the private archive root, source and package inputs, assertion path, installed Convex package ancestry, manifest, and CLI; every captured regular file must have exactly one link. It rechecks the complete identity set immediately before launching the authority-contained provider process. A detected symlink, hard-linked file, ancestor replacement, or file substitution refuses before launch. Provider execution uses that archived CLI and assertion rather than the operator checkout's mutable dependency tree. HRA then overlays only `convex/releaseAttestation.ts` with the bound source commit, fresh runtime revision, deployment time, and null predecessor, and deploys from that tree. An install refusal cannot reach provider execution. Any unproven install or deployment cleanup retains the entire private source root in the reported recovery paths. The operator checkout remains unchanged. The postflight query must return that exact attestation on the same fixed numeric target tuple before final evidence is published.

These identity checks detect substitutions visible at their explicit checkpoints. They are not a filesystem sandbox against hostile code already running as the same operating-system user, which could race pathname access after a check or modify an inode in place. Do not run the release operator beside untrusted same-UID code. Authority containment owns provider-process descendants; it does not expand this filesystem boundary.

Deploy the candidate from its exact clean detached commit and bind it to the bootstrap receipt:

```sh
bun run hosted:deploy -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --source-commit <N_COMMIT> \
  --phase candidate \
  --previous-deploy-evidence /protected/release/bootstrap-deploy.json \
  --evidence-path /protected/release/candidate-deploy.json
```

The candidate intent requires its `before` attestation to equal the bootstrap `after` attestation, names the bootstrap evidence digest as its predecessor, advances deployment time and runtime revision, and binds `runtimeSourceCommit` to `N_COMMIT`. A bootstrap may be an earlier clean commit; the candidate must be the release commit. Losing CLI output never authorizes a speculative redeploy. A retry may finalize only when the durable intent, current runtime attestation, fixed target, and prior evidence still match exactly. Drift or an ambiguous provider read is a refusal. An exact completed evidence file replays through read-only attestation and target checks without deploying.

There is one exceptional supersession path for a bootstrap intent that cannot deploy its source. Use it only with independent evidence that the failed Convex process stopped determinately before the remote `runPush` mutation boundary, local process cleanup is proven, the exact numeric target is reverified, and a fresh authority read exactly equals the failed intent's recorded `before` attestation. Launching Convex or performing read-only target resolution does not disqualify this path. Any possibility that `runPush` began prohibits it. Keep the failed source-qualified evidence path and its `.intent` unchanged as quarantine evidence. From a newer exact clean fixed commit, choose a different source-qualified evidence path in the same protected release directory and run bootstrap there under the single release authority. Never delete, rename, overwrite, or retry the failed path from the newer checkout. Once the new runtime binds, its non-null attestation makes the old null-before intent inert and any replay of the old path fails closed. An ambiguous mutation boundary, changed or unreadable runtime, unproven cleanup, target drift, reused path, or missing old intent prohibits supersession.

Deployment intents and final documents use canonical SHA-256 JSON, bounded no-follow reads, exclusive mode-`0600` files, descriptor and path identity checks, file and directory sync, and atomic no-replace publication. Retain the `.intent` beside its final evidence until the release is complete.

## Configure secrets

`bun run hosted:configure` accepts one strict JSON object with exactly these fields:

```json
{"authEmailReplyTo":"ben@substrate.run","resendApiKey":"<secret>","siteUrl":"https://hra.sh"}
```

`siteUrl` must be one HTTPS origin. For the HRA `v0.1.0` authority it is exactly `https://hra.sh`, the final canonical origin. Do not substitute `https://try-hra.vercel.app` or an automatic deployment hostname: configuration is one-shot, while staging aliases move and rehearsal may replace candidate deployments. `resendApiKey` must be a Resend sending key. HRA pins every OTP sender to `HRA sign-in <hra@auth.hraness.com>` in source; the operator cannot replace it with an environment value. `authEmailReplyTo` must be one lowercase canonical mailbox without an apostrophe that is monitored and verified to receive mail. The sending-only `auth.hraness.com` and `news.hraness.com` domains are rejected. If the runtime variable is absent, HRA falls back to the receive-capable `ben@substrate.run` mailbox. The helper generates a fresh 2048-bit RS256 private key, its matching public JWKS, and a 256-bit HMAC secret locally with WebCrypto.

Pass the JSON from a protected secret source through standard input:

```sh
protected-json-source | bun run hosted:configure -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

An agent can use a private nonterminal descriptor:

```sh
bun run hosted:configure -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --input-fd 3 3< <(protected-json-source)
```

Replace `protected-json-source` with a password manager or equivalent process that emits the complete JSON document only into the pipe. Do not put any value in an argument, environment variable, shell assignment, temporary file, clipboard transcript, `tee`, or traced shell. Do not paste the document into a shell command. Keep shell tracing disabled.

The helper reads at most 8 KiB, rejects a terminal descriptor, and ignores inherited credential variables. Before and after the provider commands, it performs the same numeric management-API identity proof used by deployment. The only setup datum it gives Convex in argv is the exact generated deployment name. It first reads environment names with `convex env list --names-only`. It then sends one in-memory dotenv document to `convex env set` over a pipe without `--force`, and reads names again. Provider stdout and stderr are never forwarded. Success means all and only these HRA values were submitted:

- `SITE_URL`
- `JWT_PRIVATE_KEY`
- `JWKS`
- `HRA_AUTH_HMAC_SECRET`
- `HRA_RESEND_API_KEY`
- `HRA_AUTH_EMAIL_REPLY_TO`

If any target name already exists, the names response is ambiguous, Convex refuses the batch, or the final names readback is incomplete, the helper closes with a generic error. A failure after the batch may have left a complete or partial provider write. Do not retry or overwrite. Inspect names only, then replace the still-unused deployment if the result is uncertain.

## Read hosted preflight status

Before a controlled live-acceptance run, an operator can read one bounded,
non-atomic preflight observation for the exact default production deployment:

```sh
bun run hosted:status -- \
  --source-commit <exact-40-char-lowercase-commit> \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

The command requires a caller-supplied exact 40-character lowercase source
commit and all five exact target fields, proves the default target immediately
before and after every provider read, and emits one JSON line. It does not
prove that the caller's checkout is clean or that the supplied commit is the
intended release. Every valid observation exits zero. Add `--require-passed`
when an agent needs a shell gate: it still emits the record but exits one
unless the status is `preflight_passed` or `live`.
Malformed, unavailable, or ambiguous provider reads exit one; unresolved local
custody exits 75.

The record exposes only the release-attestation binding state, whether all six
HRA-managed environment *names* are present and which of those static names
are missing, a capped count of occupied bootstrap tables plus a closed
bootstrap classification, and the safe admission generation, state, and
new-identity admission value. A deployment that predates the new-identity
control reports no value, which the operator reads as `invite_only` exactly as
the authority does. It never
emits environment values, unrelated environment names, invitation material,
quota totals, user counts, or database rows. `CONVEX_SITE_URL` is
Convex-owned runtime configuration, not an HRA-managed protected value, so it
is intentionally neither required nor reported by this command.

`preflight_passed` means the bound release attestation names the supplied
source commit, the six managed names are present, and the deployment presents
the exact first-bootstrap authority frame with open generation-zero admission.
`live` means the same runtime and environment facts hold, the first invitation
was accepted (the control row carries a durable accepted timestamp ordered
after bootstrap completion), and admission is open at any generation. An
accepted deployment with frozen admission is `preflight_incomplete` with
`resume_admissions` as guidance. A bootstrapped deployment whose first
invitation is unaccepted but no longer in the exact first frame, for example
after a reissue or an admission transition, is `preflight_inconsistent`; the
reissue section describes the only reviewed recovery.
The JSON `releaseAttestation.state` is `current`, `other`, or `unbound`; HRA
does not print the deployed commit. Its closed `nextAction` is guidance only,
not authorization for a mutation. This does not validate environment values or
sender verification, acquire a provider lock, send an OTP, or prove a live
encrypted-sync path. The reads are sequential and do not acquire a provider
lock or snapshot, so treat the result only as a bounded non-atomic prerequisite
for the controlled live-acceptance scenario.

This is provider-read-only, not filesystem-pure: it runs bounded Convex CLI
reads through the authenticated CLI session on macOS or Linux, and it must not
be used as an authorization shortcut for configure, bootstrap, DNS, or alias
changes.

## Establish hosted authority and issue the first invite

No authentication, OTP, invitation, device, or application write may happen before bootstrap. One request-bound mutation atomically establishes hard quota authority, open generation-zero authentication-admission authority, a durable binding to the first invitation digest, and the charged first invitation. Choose a new absolute output path in a private operator directory. The path must not exist. Run the one-shot bootstrap on the exact new production deployment:

```sh
bun run hosted:bootstrap -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-output /absolute/private/path/identity-invite
```

The helper uses authenticated CLI state, strips inherited Convex deploy credentials and any inherited value containing an invitation capability, bounds every provider call, and performs numeric target preflight and postflight. It performs this closed sequence:

- Read at most two `storageUsageService`, `serviceControl`, `maintenanceState`, and `authInvites` rows through one bounded inline query and require all four exact empty arrays. Scheduled maintenance is hard-gated on quota authority and may not create its cursor first.
- Resolve and open the output's existing parent as a no-follow directory, require that it is owned by the invoking user with exact mode `0700`, hold and repeatedly verify its owner, mode, device, and inode, then reserve the requested output with no-follow, exclusive creation and mode `0600`. Existing files, shared parent directories, and final-component symlinks are refused before mutation.
- Generate the 256-bit bearer capability locally. Derive its remote public ID from its purpose-separated SHA-256 digest, sync only the capability plus a newline to the reserved file, and verify the same single-link mode-`0600` inode. This protected local custody is durable before the first provider mutation. The capability never enters provider arguments, environment, stdout, or stderr.
- Run `quota:genesisHostedAuthority` with only the digest, derived public ID, and exact 24-hour lifetime. The mutation requires every covered authentication, invitation, device, application, quota, maintenance, and service-control table to be pristine. In one Convex transaction it creates the hard quota singleton, the open service-control singleton with the complete bootstrap binding, the first identity invitation, and its exact service quota charge. A concurrent request with a different full capability digest is refused. Replaying the exact request is neutral.
- Read all three rows again. Require exactly one strict `global` hard quota row charged for exactly one service-owned invitation and zero user data, one strict open generation-zero service-control row bound to this full digest, public ID, and lifetime, and one strict issued invitation with the same binding. Recompute the stored invitation's Convex logical size locally and require both aggregate and service byte counters to equal it.
- Read the exact numeric provider identity again after the mutation. A pre-custody failure removes only the inode this process reserved. Once custody is durable, every failure preserves the capability file for deterministic recovery.

Provider stdout, provider stderr, and the capability are never forwarded. Success returns one bounded JSON object with the safe public invite ID and non-secret invitation state. It attests that the request-bound hosted authority and exact quota charge were read back and that the capability reached the protected file. Record the public ID so the first invitation can be inspected or revoked without reading its capability.

A refusal means the deployment was dirty, another request won bootstrap, provider output was ambiguous, exact authority or quota readback failed, or the output could not be protected. Do not overwrite or discard a populated capability file. Reconcile the exact default deployment first, then recover only through the bootstrap operator with that same file:

```sh
bun run hosted:bootstrap -- recover \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-file /absolute/private/path/identity-invite
```

Recovery accepts only an invoking-user-owned, single-link, mode-`0600` regular file inside the same owned mode-`0700` directory. It rederives the full request binding, invokes only `quota:genesisHostedAuthority`, and requires the same exact three-row readback. It can finish a crash that happened after local custody but before the mutation, and it can reconcile a lost mutation response through exact durable state. It never calls ordinary `authInvites:recordIssue`. A different winner returns `bootstrap_authority_conflict`; the losing file remains intact and must never be passed to `hosted:invites recover`.

If no populated capability file exists and every pre-bootstrap authority remains empty, replace the still-unlaunched deployment and repeat the full fresh-state sequence.

One further state has a reviewed recovery: bootstrap completed, nobody accepted the first invitation before its 24-hour lifetime ended, and the protected capability file is gone. The deployment then holds valid quota and admission authority but no identity, and friend issuance stays locked forever because acceptance never happened. Reissue the first invitation instead of replacing the deployment:

```sh
bun run hosted:bootstrap -- reissue \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-output /absolute/private/path/identity-invite-2
```

The reissue pre-read must positively show one bootstrapped service-control row without an accepted timestamp, at most one invitation, and that invitation must be the bound first invitation and already expired. Scheduled maintenance may already have removed the expired row; then the quota counters must read zero records. Any admission generation is accepted, frozen or open, because admission is unrelated to the first invitation. Every other shape, including an invitation that is still active, refuses before a capability is generated or an output path is reserved. Custody then follows the same protected-file sequence as bootstrap. The operator runs only `quota:reissueHostedBootstrapInvite`, which in one Convex transaction requires zero identities and zero users, releases the expired invitation and its quota charge, inserts the new charged first invitation, and rebinds service control to the new digest, public ID, and lifetime. Replaying the exact request while the reissued invitation is active is neutral; a different digest while it is active is refused. The readback requires the same exact three-row binding as genesis except that the control row keeps its current admission generation, state, and mutation ID. A crash after custody recovers with `reissue --invite-file` and the same protected file. Reissue never unlocks friend issuance; only acceptance does.

Any other state is an incident and must remain quarantined for inspection.

## Accept the first invite

Read the capability file only into HRA's protected authentication JSON input. Never print it, substitute it into argv, copy it into an environment variable, or route it through a log. Complete the verified-email code flow and confirm the identity and first device are active. Consuming this specific bound invitation atomically records a durable bootstrap-accepted timestamp in service control. Later friend invitation issuance depends on that durable fact, so maintenance may remove the terminal invitation receipt without relocking the service. Then remove the one-time capability file.

Continue launch acceptance with a second pending device approved by the active device against the key fingerprint that `hra device list` shows for it, encrypted projection sync in both directions, usage upload cadence, session streaming, command custody, interaction resolution, revocation, and account deletion. Keep hosted invitations disabled. Hosted acceptance does not authorize domain movement or publication. Those effects require a future current-project-only release design; retired HRA v0 resources cannot satisfy one of its gates.

## Operate friend-beta invitations

Run the friend-beta operator only after the one-shot bootstrap and first-invite acceptance are complete. The server refuses new friend invitations until the durable bootstrap-accepted fact exists. This operator never creates or retries hosted authority. Do not run fresh `hosted:bootstrap` on an initialized deployment; use its dedicated `recover` command only for the original protected bootstrap file.

Issue one 24-hour identity invite into a new absolute path whose parent is an existing invoking-user-owned mode-`0700` operator directory:

```sh
bun run hosted:invites -- issue \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-output /absolute/private/path/friend-name.invite
```

The output path must not exist. The operator reserves it with no-follow exclusive creation, fixes and verifies mode `0600`, generates the capability locally, and durably commits it before provider access. Convex receives only the capability digest and deterministic public ID through an idempotent mutation. It never receives or returns the bearer capability. The operator never puts the capability in argv, an environment variable, terminal output, provider output, or a temporary file. Success prints one bounded JSON object containing the safe public invite ID and non-secret state. Record that public ID in the private release record, then deliver the capability file through the same protected authentication-input flow used for the first invite.

If issuance returns an indeterminate refusal after the capability file was committed, restore exact default-target certainty and recover from the same file:

```sh
bun run hosted:invites -- recover \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-file /absolute/private/path/friend-name.invite
```

Recovery accepts only an owned, single-link, mode-`0600` regular file inside an owned mode-`0700` parent, holds and revalidates both inodes, reads the file without following links, and rederives the digest and public ID. It first reads status by that public ID. Existing issued, bound, consumed, or revoked state is returned without replay. If no row exists, it invokes the same idempotent record mutation and then requires a second status readback. A malformed or lost mutation response is therefore reconciled from durable remote state. Failure preserves the file and prints no capability.

Read status with the public ID:

```sh
bun run hosted:invites -- status \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --public-id invite_PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP
```

Revoke the same invite when delivery is abandoned or access should end:

```sh
bun run hosted:invites -- revoke \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --public-id invite_PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP
```

Status and revoke accept only the public ID, never the bearer capability. Revoke reads and validates identity-invite status before mutation. Every operation performs authenticated numeric target readback before and after its bounded Convex call, requires the exact HRA team, project, production deployment, generated name, and URL, and refuses retired HRA v0 project ID `2680173` and deployment ID `4677913`. Provider stdout and stderr are suppressed; failures return only a static refusal code.

If issuance is refused after protected custody commits, do not repeat `issue` with a new path. Reconcile the exact default deployment, then use `recover` with the preserved file. Keep the file until a strict result returns its deterministic public ID or the deployment is formally quarantined.

## Operate open sign-up

Two independent controls live on the single `serviceControl` row.
`authAdmissions` is the break-glass: `frozen` refuses every authenticated
path, including verification and device pairing for existing members, so it
locks out the whole service and is never the way to close sign-up.
`newIdentityAdmissions` is the narrow control: `invite_only` (the default, and
the meaning of an absent stored value) or `open`. It is read in exactly one
place, where a first `authSubjects` row would be inserted without an
invitation. Everything else is unchanged: a frozen deployment still refuses an
open sign-up before writing any row, identity invitations keep working while
sign-up is open, and a subject admitted without an invitation carries
`admittedBy: "open"` so no later step ever treats a missing invitation as
permission.

Both controls share one generation fence and one mutation identity, so a
change to either advances `authAdmissionGeneration` and an exact replay stays
recognisable. Read the current generation first:

```sh
bun run hosted:admission -- status \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

Open sign-up with the exact generation that status returned, a fresh UUIDv7,
and the explicit acknowledgement:

```sh
bun run hosted:admission -- new-identities \
  --new-identities open \
  --expected-generation <GENERATION> \
  --mutation-id <FRESH_UUIDV7> \
  --acknowledge-open-signup \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

Close it again with `--new-identities invite_only` and no acknowledgement.
The acknowledgement is required exactly for the `open` direction, as
`--acknowledge-resume` is for resuming admissions. The operator proves the
exact default target before and after every provider call, refuses a request
whose expected generation is stale, refuses a change the deployment already
has, and reconciles a lost response through durable state instead of replaying
blind. Deploy the authority change through the attested candidate chain before
opening admissions; opening sign-up against a deployment that still runs the
invite-only authority does nothing.

Abuse controls apply to every path, invited or open. One address may receive 3
codes per 15 minutes and 5 per 24 hours, and at most 10 for its lifetime while
it has never verified. The service admits 200 sends per hour, 1,000 per day,
and 200 newly admitted identities per rolling 24 hours, counted on the service
control row. Verification attempts keep their own limits: 100 per hour service
wide and 10 per 15 minutes per address. One verified email owns exactly one
identity: a second subject can never be verified onto the same address or the
same user. Budget a paid Resend plan before opening sign-up; the free tier
delivers 100 messages per day, well under the send ceiling.

## Beta free tier and service ceilings

One identity gets 200 MiB of server-visible logical bytes, 50,000 session
chunks, 20,000 live-tail chunks, 10,000 session heads, 16 devices, 32 Codex
accounts, 256 nonterminal remote commands, and 100,000 usage snapshots per
account. The deployment ceiling is 5,000 identities, 100 GiB, and 25 M
records. The identity count is deliberately oversubscribed against the byte
ceiling: 5,000 tiers of 200 MiB would be 1,000 GiB, so the service byte
ceiling is the real hard stop and must be raised before the service approaches
it. Worst-case usage telemetry for one Codex account before any row becomes
cleanup-eligible is 16,888,144 logical bytes, under a tenth of the tier; the
tier holds twelve such accounts at once.

These constants are hard authority. A stored counter above the constant reads
as corrupt and fails closed, so never lower a ceiling below what a deployment
already stores. Read current usage first, and deploy a tier change through the
attested candidate chain before it can matter.
