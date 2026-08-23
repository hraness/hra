# Hosted sync deployment

Use this sequence only for a new HRA Convex project and production deployment. The setup helper refuses an existing HRA environment by default. It does not support overwrite.

Never copy HRA v0 data, deployment URLs, deploy keys, authentication keys, HMAC material, Resend credentials, environment values, or backups into the new project. Keep the old project and deployment unchanged for rollback.

The provider identity guard pins the intended Convex team to numeric ID `513923` and provider slug `cclrte`. HRA v0 owns Convex project ID `2680173` and production deployment ID `4677913`; neither may be renamed into or selected by this runbook. The new source repository has GitHub repository ID `1343008607`, and the new web project has Vercel project ID `prj_8ciIt9t9foE3utG45frRN7cxckjS`. Project and deployment names may change during cutover. The team identity and numeric resource IDs do not.

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
     --project-id 1234567 \
     --deployment-id 7654321 \
     --deployment-url https://steady-otter-321.convex.cloud \
     --source-commit 0123456789abcdef0123456789abcdef01234567
   ```

   The helper requires `HEAD` to equal that commit and the entire checkout, including untracked files, to be clean before and after deployment. It refuses any caller team ID except `513923`, then reads the authenticated Convex management API before and after the mutation and requires team slug `cclrte`, team ID `513923`, the exact project, deployment, production type, generated deployment name, URL, and two matching default-production facts: the deployment reports `isDefault: true` and the project names that deployment as `prodDeploymentName`. It rejects selectors such as `prod`, `local`, and `team:project:prod`, and rejects the HRA v0 numeric IDs.

   The helper creates a private exclusive environment file containing only `CONVEX_DEPLOYMENT=prod:<generated-name>`. Convex uses that value as project context and deploys to the project's current default production deployment, so the matching default-production readbacks are part of the target guard rather than an informational check. After Convex resolves the actual deployment credentials and before it pushes, its mandatory `--cmd` exposes the resolved canonical cloud URL only to a silent local assertion. That assertion must match the exact expected deployment URL or the deploy stops before `runPush`; a later default change cannot redirect the already-resolved credentials. The helper disables Convex's optional pre-command WorkOS provisioning because HRA does not use Convex AuthKit and no provider mutation may precede this assertion. It otherwise invokes `convex deploy --env-file` with confirmation disabled, strict typechecking, code generation disabled, sanitized inherited environment variables, bounded provider output, and a ten-minute deadline. Provider output is suppressed. A failure, changed default, resolved-target mismatch, or dirty postflight leaves the deployment quarantined for inspection; do not retry it.

## Configure secrets

`bun run hosted:configure` accepts one strict JSON object with exactly these fields:

```json
{"authEmailFrom":"HRA Auth <auth@example.com>","resendApiKey":"<secret>","siteUrl":"https://example.com"}
```

`siteUrl` must be one HTTPS origin. `resendApiKey` must be a Resend key. `authEmailFrom` must be the verified sender accepted by Resend. The helper generates a fresh 2048-bit RS256 private key, its matching public JWKS, and a 256-bit HMAC secret locally with WebCrypto.

Pass the JSON from a protected secret source through standard input:

```sh
protected-json-source | bun run hosted:configure -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 1234567 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

An agent can use a private nonterminal descriptor:

```sh
bun run hosted:configure -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 1234567 \
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

## Establish hard quota authority and issue the first invite

No authentication, OTP, invitation, device, or application write may happen before quota genesis. Choose a new absolute output path in a private operator directory. The path must not exist. Run the one-shot bootstrap on the exact new production deployment:

```sh
bun run hosted:bootstrap -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 1234567 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-output /absolute/private/path/identity-invite
```

The helper uses the authenticated CLI state, strips inherited Convex deploy credentials, and performs numeric target preflight and postflight. It performs this closed sequence:

- Read at most two `storageUsageService` rows through a bounded inline query and require an exact empty array.
- Resolve and open the output's existing parent as a no-follow directory, hold and repeatedly verify its device and inode, then reserve the requested output with no-follow, exclusive creation and mode `0600`. Existing files and final-component symlinks are refused before mutation. The new directory entry is synced before genesis, so an issued capability can never depend on an output reservation that existed only in memory.
- Run `quota:genesisHardAuthority` and require exactly `{"enforcement":"hard"}`. The mutation atomically refuses every pre-genesis authentication, invitation, device, application, or quota row covered by hard authority.
- Read the authority again and require exactly one strict `global` row in `hard` mode, with all identity, record, logical-byte, service, and user counters at zero.
- Run `authInvites:issue` once for a 24-hour identity invite and parse one strict result.
- Read the exact numeric provider identity again after invite issuance and before disclosing the capability locally.
- Sync only the bare bearer capability plus a newline to the already reserved file. Verify that the same inode remains a regular, single-link, mode-`0600` file, sync the parent directory again, and close both held handles. Abort removes only the inode this process reserved and syncs that removal.

Provider stdout, provider stderr, and the capability are never forwarded. The safe success line attests that hard zero authority was read back before the first invitation write and that the capability reached the protected file.

A refusal means the deployment was dirty, genesis already existed, provider output was ambiguous, the exact zero singleton was not proven, invite issuance failed, or the output could not be protected. Do not retry or overwrite after any genesis attempt. Replace the still-unlaunched deployment and repeat the full fresh-state sequence.

## Accept the first invite

Read the capability file only into HRA's protected authentication JSON input. Never print it, substitute it into argv, copy it into an environment variable, or route it through a log. Complete the verified-email code flow, confirm the identity and first device are active, then consume and remove the one-time capability file.

Continue launch acceptance with a second pending device approved by the active device, encrypted projection sync in both directions, usage upload cadence, session streaming, command custody, interaction resolution, revocation, and account deletion. Keep hosted invitations disabled and do not move `hra.sh` until every live acceptance and rollback gate in the release plan passes.
