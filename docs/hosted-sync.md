# Hosted sync deployment

Do not perform any provider write in this runbook until the user supplies the exact authorization phrase `approve both`. That phrase authorizes the paired hosted setup only: Resend GitHub OAuth and creation of the sending-only Resend key, followed by the checked hosted secret and bootstrap writes described here.

`approve both` does not authorize DNS. Do not add, change, or remove any DNS record, domain assignment, or production alias until the user separately confirms the exact record-level change. Keep `hra.sh`, the HRA v0 project, and every rollback route unchanged meanwhile.

Use this sequence only for a new HRA Convex project and production deployment. The setup helper refuses an existing HRA environment by default. It does not support overwrite.

Never copy HRA v0 data, deployment URLs, deploy keys, authentication keys, HMAC material, Resend credentials, environment values, or backups into the new project. Keep the old project and deployment unchanged for rollback.

The provider identity guard pins the intended Convex team to numeric ID `513923` and provider slug `cclrte`. HRA v0 owns Convex project ID `2680173` and production deployment ID `4677913`; neither may be renamed into or selected by this runbook. The new source repository has GitHub repository ID `1343008607`, and the new web project has Vercel project ID `prj_8ciIt9t9foE3utG45frRN7cxckjS`. Project and deployment names may change during cutover. The team identity and numeric resource IDs do not.

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

## Create fresh state

1. Create a new Convex project and production deployment in Convex team `cclrte` with numeric team ID `513923`.
2. Record the new Convex project ID, production deployment ID, deployment name, deployment URL, and site URL in the private release record.
3. Read those values back from Convex. Attach the readback to the release record and prove that both new numeric IDs and the deployment URL differ from HRA v0 project ID `2680173`, deployment ID `4677913`, and its deployment URL. Stop on a missing, reused, or name-only identity.
4. Log in with the Convex CLI. Its global `config.json` must be a regular, single-link, mode-`0600` file. Do not supply a deploy key or deployment selector through an environment variable, `.env`, or `.env.local`.
5. Record the exact clean 40-character lowercase Git commit. Deploy that source before any authentication or invitation write. Substitute the five provider values and exact commit below:

   ```sh
   bun run hosted:deploy -- \
     --deployment steady-otter-321 \
     --team-id 513923 \
     --project-id 2854545 \
     --deployment-id 7654321 \
     --deployment-url https://steady-otter-321.convex.cloud \
     --source-commit 0123456789abcdef0123456789abcdef01234567
   ```

   The helper requires `HEAD` to equal that commit and the entire checkout, including untracked files, to be clean before and after deployment. It refuses any caller team ID except `513923`, then reads the authenticated Convex management API before and after the mutation and requires team slug `cclrte`, team ID `513923`, the exact project, deployment, production type, generated deployment name, URL, and two matching default-production facts: the deployment reports `isDefault: true` and the project names that deployment as `prodDeploymentName`. It rejects selectors such as `prod`, `local`, and `team:project:prod`, and rejects the HRA v0 numeric IDs.

   The helper creates a private exclusive environment file containing only `CONVEX_DEPLOYMENT=prod:<generated-name>`. Convex uses that value as project context and deploys to the project's current default production deployment, so the matching default-production readbacks are part of the target guard rather than an informational check. After Convex resolves the actual deployment credentials and before it pushes, its mandatory `--cmd` exposes the resolved canonical cloud URL only to a silent local assertion. That assertion must match the exact expected deployment URL or the deploy stops before `runPush`; a later default change cannot redirect the already-resolved credentials. The helper disables Convex's optional pre-command WorkOS provisioning because HRA does not use Convex AuthKit and no provider mutation may precede this assertion. It otherwise invokes `convex deploy --env-file` with confirmation disabled, strict typechecking, code generation disabled, sanitized inherited environment variables, bounded provider output, and a ten-minute deadline. Provider output is suppressed. A failure, changed default, resolved-target mismatch, or dirty postflight leaves the deployment quarantined for inspection; do not retry it.

## Configure secrets

`bun run hosted:configure` accepts one strict JSON object with exactly these fields:

```json
{"authEmailFrom":"HRA Auth <auth@example.com>","resendApiKey":"<secret>","siteUrl":"https://hra.sh"}
```

`siteUrl` must be one HTTPS origin. For the HRA `v0.1.0` authority it is exactly `https://hra.sh`, the final canonical origin. Do not substitute `https://try-hra.vercel.app` or an automatic deployment hostname: configuration is one-shot, while staging aliases move and rehearsal may replace candidate deployments. `resendApiKey` must be a Resend key. `authEmailFrom` must be the verified sender accepted by Resend. The helper generates a fresh 2048-bit RS256 private key, its matching public JWKS, and a 256-bit HMAC secret locally with WebCrypto.

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
- `HRA_AUTH_EMAIL_FROM`

If any target name already exists, the names response is ambiguous, Convex refuses the batch, or the final names readback is incomplete, the helper closes with a generic error. A failure after the batch may have left a complete or partial provider write. Do not retry or overwrite. Inspect names only, then replace the still-unused deployment if the result is uncertain.

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

If no populated capability file exists and every pre-bootstrap authority remains empty, replace the still-unlaunched deployment and repeat the full fresh-state sequence. Any other state is an incident and must remain quarantined for inspection.

## Accept the first invite

Read the capability file only into HRA's protected authentication JSON input. Never print it, substitute it into argv, copy it into an environment variable, or route it through a log. Complete the verified-email code flow and confirm the identity and first device are active. Consuming this specific bound invitation atomically records a durable bootstrap-accepted timestamp in service control. Later friend invitation issuance depends on that durable fact, so maintenance may remove the terminal invitation receipt without relocking the service. Then remove the one-time capability file.

Continue launch acceptance with a second pending device approved by the active device, encrypted projection sync in both directions, usage upload cadence, session streaming, command custody, interaction resolution, revocation, and account deletion. Keep hosted invitations disabled. After exact-source live acceptance and Q rollback readiness pass, the checked domain operator may move `hra.sh` for the required forward and reverse rehearsal. The production forward move remains prohibited until that rehearsal and every other rollback gate in the release plan pass.

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

Status and revoke accept only the public ID, never the bearer capability. Revoke reads and validates identity-invite status before mutation. Every operation performs authenticated numeric target readback before and after its bounded Convex call, requires the exact HRA team, project, production deployment, generated name, and URL, and refuses HRA v0 project ID `2680173` and deployment ID `4677913`. Provider stdout and stderr are suppressed; failures return only a static refusal code.

If issuance is refused after protected custody commits, do not repeat `issue` with a new path. Reconcile the exact default deployment, then use `recover` with the preserved file. Keep the file until a strict result returns its deterministic public ID or the deployment is formally quarantined.
