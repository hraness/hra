# Current HRA canonical alias release

HRA v0 status: retired on 2026-08-27. This procedure is current-project-only.

This runbook can reassign the single Vercel alias record `hra.sh` between two exact deployments of the current HRA Vercel project. It does not add, change, or remove DNS, move project-domain ownership, deploy source, configure Convex, create a tag, publish a release, or operate another alias.

## Authorization boundary

Do not run the mutating command until the user separately confirms the exact source-to-target record printed by `preflight`. General release approval and the hosted-sync phrase `approve both` do not authorize this alias change. A confirmation for a hostname, commit, or deployment by itself is insufficient; the confirmation must name the exact alias, current Vercel project, source deployment ID and URL, target deployment ID and URL, and the plan's lowercase UUID.

The reviewed fresh plan is not authorization. `--confirm-exact` is accepted only when its value is byte-for-byte equal to the record and UUID derived from that plan. The authorization includes automatic restoration of `hra.sh` to the plan's exact current-project source deployment if an acknowledged target cannot be proved. It does not authorize HRA v0, another alias, DNS, or project-domain ownership.

Execution has exactly one designated writer custodian: one supported Darwin or Linux host and one persistent operating-system account holding the reviewed file-backed Vercel session, protected Convex session, and durable state directory. The local lock cannot fence another host or account, and the alias API has no expected-source compare-and-swap. Do not run this operator or another alias writer from a second host or account while a plan or recovery is live. Other devices may inspect evidence or convey the exact confirmation, but they may not dispatch provider writes.

## Fixed identities and denylist

The only accepted authorities are:

- GitHub repository `hraness/hra`, numeric ID `1343008607`;
- Vercel team `hraness`, stable ID `team_UAd1iD2XogJlbFg4h14mRaPM`;
- Vercel project ID `prj_8ciIt9t9foE3utG45frRN7cxckjS`;
- Convex team ID `513923`, project ID `2854545`, and the exact default production deployment named in the plan; and
- canonical alias `hra.sh`.

The following retired HRA v0 identities remain one-way safety tombstones:

- GitHub repository ID `1334876494`, retained only as archived `hraness/hra-v0` history;
- Vercel project ID `prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr`;
- Convex project ID `2680173`; and
- Convex production deployment ID `4677913`.

The new plan schema accepts only the current numeric identities, so none of those retired resources can become a target, source, fallback, staging surface, or recovery authority. The historical implementation in `scripts/domain-cutover.ts` remains non-operational design evidence: its executable and public operator entry points return `operator_retired`, and it has no built-in provider runner. Historical tests can exercise its parser and state machine only by supplying their own explicit effect capability. Do not invoke or import it for provider work.

A normal source and every target must be an exact Vercel `source: "git"` GitHub deployment of repository ID `1343008607`, ref `main`, and the plan commit. Contradictory hybrid source metadata is rejected. One narrow source-only compatibility form exists for the current public alias when that alias still names a pre-integration Vercel CLI deployment. The plan must opt into `vercel.sourceProvenance` with the exact closed values `kind: "vercel-cli-public-marker"`, `actor: "cursor-cli"`, `gitCommitRef: "HEAD"`, and `gitRootDirectory: ""`. This does not admit a CLI target. It binds the source to the exact deployment ID, hostname, plan commit, Vercel `source: "cli"`, null `gitSource`, matching deployment metadata, the strict public marker, and an alias read-marker-read sandwich. A plan without that object retains the GitHub-only source contract.

## Fresh plan for each release

Do not use a checked or previously preflighted plan for a later deployment. After the reviewed operator is on `main` and its exact production deployment is ready, prepare a private schema-version-1 plan at `<absolute-path-to-fresh-plan>`. Keep that file outside the repository as a single-link mode-`0600` regular file owned by the designated operating-system account. It must bind:

- the exact source deployment ID, automatic hostname, commit, and explicit source-only CLI provenance object when the current alias requires that compatibility form;
- one different `READY` GitHub `main` target deployment, automatic hostname, and source commit from repository ID `1343008607`;
- current Convex production deployment ID `5089017`, generated name `qualified-hummingbird-537`, and URL `https://qualified-hummingbird-537.convex.cloud`; and
- a newly generated lowercase canonical UUIDv4 idempotency key.

The alias operator never changes Convex; exact live default-production readback is a release-authority prerequisite. The fresh UUID is part of `requiredConfirmation`, so a byte-identical old phrase cannot authorize a new plan. Never edit a plan or reuse its key after its exact confirmation has been requested. Discard it, prepare and preflight a replacement, and request the new UUID-bound exact confirmation.

## Provider readback contract

Use Bun 1.3.14. Both the executable entry point and the explicit-capability test boundary reject any other Bun version before argument recovery, provider reads, or durable alias state mutation. The canonical `--vercel-auth-fd` path supports Darwin and Linux by making bounded HTTPS requests directly to fixed paths at `https://api.vercel.com`, with the stable Vercel team ID in every request. It rejects redirects, non-JSON responses, oversized bodies, and responses outside the strict endpoint schemas. This path starts no Vercel subprocess and performs no Vercel CLI discovery. A separate explicit `--vercel-cli` compatibility path remains available only on Linux under the repository's PID-namespace authority supervisor. Do not use that legacy path for this Darwin-capable procedure. Any credential-bearing provider subprocess remains authority work with no process-group fallback.

Select one reviewed file-backed Vercel session for the designated operating-system account and open it on the descriptor supplied through `--vercel-auth-fd`. The held descriptor must not be a TTY and must identify a current-user-owned, single-link, mode-`0600` regular file within the bounded size limit. Darwin also rejects any extended access-control list. The operator recognizes only the bounded session token and optional expiry, closes the credential descriptor before bounded-process journal recovery or any provider call, sends the token in the Vercel authorization header, and never writes the token to output, logs, argv, the plan, intent, or receipt. An expiring token must have at least 15 minutes remaining at the start of each preflight or execution invocation; a shorter, malformed, or expired session is refused before recovery or provider work, and the margin provides headroom for the bounded forward-and-restoration path. The operator does not refresh the token and does not discover one from an environment variable, inherited `HOME`, default CLI configuration path, Keychain, or another ambient account source. Review the exact file before opening the descriptor, keep the same file and operating-system account through preflight and execution, and never pass the token itself as a command-line value.

Preflight and execution read the following state from the providers instead of trusting names or a prior observation:

1. Convex management API readback must prove the plan's exact numeric team, project, production deployment ID, generated name, canonical URL, `isDefault: true`, and matching project `prodDeploymentName`. The protected Convex CLI config path is derived from the operating-system account record rather than inherited `HOME`; its held file must be current-user-owned, single-link, regular, mode `0600`, stable across the bounded read, and free of any Darwin extended ACL.
2. Vercel project readback from `/v9/projects/prj_8ciIt9t9foE3utG45frRN7cxckjS` must return the exact project and team IDs and `autoAssignCustomDomains: false`.
3. Vercel deployment readback from `/v13/deployments/<deployment-id>` must prove each exact deployment ID, automatic hostname, current project ID, and `READY` production state. The target always proves Vercel `source: "git"`, GitHub repository ID `1343008607`, `main` ref, and the plan commit. The source proves the same GitHub tuple unless the plan explicitly carries the closed CLI source provenance object; only then must it instead prove null `gitSource`, Vercel `source: "cli"`, exact actor `cursor-cli`, exact ref `HEAD`, empty root directory, and `meta.gitCommitSha` equal to the source commit in the plan.
4. Authenticated alias readback from `/v4/aliases/hra.sh` must return one exact `(alias, projectId, deploymentId, deployment.id, deployment.url)` tuple matching the plan source or target. When the source uses the narrow CLI form, the same exact source tuple must still hold after the public marker read.
5. Public `https://hra.sh/.well-known/hra.json` readback must be strict schema version 2, generation 1, product `HRA`, repository ID `1343008607`, path `hraness/hra`, version `0.1.0`, and the commit belonging to that exact alias tuple.

The protected automatic target hostname is not treated as public product evidence. Before mutation, the exact `READY` GitHub `main` deployment record is the target provider evidence. A CLI deployment can never satisfy target authority. After mutation, the public marker must bind `hra.sh` to the target commit; failure to prove that marker invokes recovery.

Provider output is parsed from `unknown`, bounded, and reduced to closed result fields. An accepted mutation response must contain the documented `uid`, `created`, and exact `alias: "hra.sh"` fields. The initial target response must also report `oldDeploymentId` equal to the plan source; an automatic source-restoration response must report it equal to the plan target. Missing, null, or unplanned prior authority fails closed. Do not use `--debug`, `--verbose`, `--token`, `--force`, remove-then-add, the friendly `vercel alias set` command, a DNS command, a certificate command, or a domain-move endpoint.

## Read-only preflight

Run preflight as the designated Darwin or Linux writer custodian from a clean checkout containing the reviewed operator. Open the reviewed Vercel session and fresh private plan on separate descriptors:

```sh
bun run release:canonical-alias preflight \
  --vercel-auth-fd 3 \
  --plan-fd 4 \
  3</absolute/path/to/reviewed-vercel-auth.json \
  4</absolute/path/to/fresh-hra-sh-plan.json
```

Preflight performs no provider write. It first takes the designated custodian's same machine-local lock and inspects the protected ledger. A receipt-less current intent returns `unresolved_current_intent`, and a different receipt-less intent returns `unresolved_prior_intent`, before provider readback; neither can be reclassified as already committed. Exact source authority with no terminal record returns `status: "ready"`, `nextAction: "confirm_exact_record_then_execute"`, and `requiredConfirmation`. Exact target authority returns `status: "already_committed"` only when no intent exists or a valid target receipt agrees. An unplanned alias, marker mismatch, provider mismatch, unreadable response, unsafe project setting, wrong Convex default, terminal receipt mismatch, or retired identity blocks or refuses.

A preflight is a point-in-time observation, not a provider lock. Execution repeats every read before mutation. Present the complete UUID-bound `requiredConfirmation` value and exact plan to the user, and wait for a separate confirmation of that record and plan instance.

## Checked execution

After, and only after, the user separately confirms the exact UUID-bound record printed by preflight, pass that exact value as one quoted argument:

```sh
bun run release:canonical-alias --execute \
  --vercel-auth-fd 3 \
  --plan-fd 4 \
  --confirm-exact '<exact requiredConfirmation from the immediately preceding preflight>' \
  3</absolute/path/to/reviewed-vercel-auth.json \
  4</absolute/path/to/fresh-hra-sh-plan.json
```

The only provider mutation form constructed by the operator is the documented direct `POST /v2/deployments/<exact-deployment-id>/aliases` request with the JSON field `alias: "hra.sh"`, scoped to stable Vercel team ID `team_UAd1iD2XogJlbFg4h14mRaPM`. The deployment ID is either the exact plan target or, only after an acknowledged target response and failed target proof, the exact plan source. The bounded in-process transport never invokes the friendly `vercel alias set` command because that command can perform implicit domain and certificate setup beyond the one alias record. Each request carries its distinct plan- and effect-derived mutation key in an `Idempotency-Key` correlation header. The alias endpoint does not document deduplication for that header, so recovery safety does not assume provider-side idempotency. An uncertain target request is never redispatched and is never followed by an opposing source write; it becomes a durable hard stop. The request does not detach the alias first and cannot select another alias or project. After an acknowledged target response with exact prior-source provenance, the operator repeatedly reads the authenticated alias tuple and public marker for at most 60 seconds, then repeats the Vercel project, both deployment, current Convex default-production, alias, and marker readbacks before returning `status: "committed"`.

Execution derives a fixed `<system-account-home>/.local/state/hra/canonical-alias-release` directory from the operating system account record, not from an inherited `HOME`. It requires a protected mode-`0700` directory and mode-`0600`, single-link regular state files. One inode-checked machine-local advisory lock serializes every plan for that designated host and account. It is not a distributed provider lock. While holding it, the operator scans the bounded directory and refuses a new plan behind any older unresolved intent. The 4,097 persistent-entry bound reserves the lock plus complete intent-receipt pairs for 2,048 terminal plans; it cannot strand the second half of a newly admitted pair. Scan startup permits only one transient 4,098th hardlink so it can finish a proved publication interrupted after its destination link was created, then requires the recovered directory to be back within the persistent bound.

For an exact source state, the operator completes one full provider read, including the second alias comparison required by an explicitly planned CLI source, durably publishes and rereads a self-digested intent, repeats the full provider read, and only then dispatches the target assignment. The intent binds the exact plan, optional source-only provenance, confirmation, observed source and intended target authorities, and distinct plan-bound mutation keys for target assignment and source restoration. A mutation is never dispatched after the lock identity is lost. A completed target postflight publishes and rereads a terminal target receipt before success is printed. A proved automatic restoration publishes and rereads a terminal source receipt before the non-success `alias_reverted` result is printed.

An exact target state with no durable intent is safe to classify read-only with the same plan and exact confirmation. A valid terminal target receipt is also replayed read-only. A lost or invalid target-command response is not reconciled into a commit from readback because the provider does not document request deduplication or delayed-effect cancellation. It returns `target_result_ambiguous` or a closed provider-readback failure with exit `75`. If an intent exists without any terminal receipt, every later invocation performs full readback but dispatches no mutation and returns `unresolved_current_intent`. It never infers target success, repeats target, or opposes a possibly delayed target with source.

## Recovery design

The plan's current-project source deployment is the only automatic recovery target. HRA v0 is never a fallback.

After an acknowledged target response whose `oldDeploymentId` proves the exact plan source, failure to prove the target alias tuple, target marker, or complete postflight reasserts only the plan's exact source automatic hostname on `hra.sh`. It then requires the source response to prove `oldDeploymentId` was the exact target and requires the exact source alias tuple, source commit-bearing marker, Vercel project, both current-project deployments, and current Convex production target to pass again. Proven restoration records a terminal source receipt and returns `status: "reverted"` with nonzero exit; it never reports a release commit. An ambiguous target response performs no automatic restoration because the delayed target effect cannot be ordered safely against an opposing source write.

If source restoration or readback cannot be proved, the operator returns exit `75` with `status: "recovery_required"` and `code: "compensation_failed"`. A target-response ambiguity returns `target_result_ambiguous`. A direct-transport failure or legacy subprocess-custody failure after intent publication also returns exit `75` with its exact recovery paths. Every failure after an intent may have been published is recovery-required, including a failed second authority read and `intent_write_failed`. Resolve the relevant file-backed session, transport, or process custody before provider reconciliation.

Durable recovery codes are closed instructions:

- `receipt_write_failed` means provider authority may already be exact target or restored source, but its terminal receipt was not proved durable. Preserve every state file. The current operator deliberately cannot infer which acknowledged or delayed phase lacks its receipt and will return `unresolved_current_intent` on the unchanged plan without a write.
- `target_result_ambiguous` means the target request returned no accepted provider response. A later exact target readback cannot prove the request's prior authority or that no delayed effect remains. Preserve the intent and perform no opposing write.
- `unresolved_current_intent` is a hard stop for the named plan. This version has no safe autonomous replay for a receipt-less intent. Recovery requires a separately reviewed, phase-aware operator revision or provider-supported ordering/CAS evidence; it is not authorized by editing or deleting the intent, reusing another UUID, or issuing a manual alias command.
- `receipt_authority_mismatch` means a terminal receipt and current provider authority disagree. Stop and investigate without another write.
- `durable_state_invalid` means the fixed directory, lock, intent, receipt, identity, digest, or bounded directory contents failed validation. Do not delete, rename, or edit the evidence to make the check pass.
- `durable_state_capacity_exhausted` is a designed stop after 2,048 terminal plan pairs. Do not remove history by hand. No new provider read or write is permitted until a reviewed operator revision adds a self-digested checkpoint or increases the bound while retaining every prior UUID and plan digest.
- `unresolved_prior_intent` means a different older plan has an intent without a terminal receipt. The error identifies that older UUID plus its exact intent and expected receipt paths. Stop behind that hard boundary. Do not start the new plan and do not delete or edit the older evidence.

For any exit `75`, stop release work, retain the unchanged plan and exact confirmation, and preserve the fixed state directory. Re-running the same plan as the same designated host and account may repeat readback, but a receipt-less intent remains a nonmutating hard stop in this operator version. Do not copy the intent to a second custodian, start a competing writer, or try a different UUID. Do not improvise a DNS change, domain move, deployment, detached alias command, HRA v0 route, new plan, or manual recovery while authority is uncertain.

After a committed result, independently repeat the filtered Vercel alias and deployment readbacks and fetch the public marker and release acceptance pages. Those observations do not expand the original authorization and must not perform another write.
