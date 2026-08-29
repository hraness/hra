# Current HRA canonical alias release

HRA v0 status: retired on 2026-08-27. This procedure is current-project-only.

This runbook can reassign the single Vercel alias record `hra.sh` between two exact deployments of the current HRA Vercel project. It does not add, change, or remove DNS, move project-domain ownership, deploy source, configure Convex, create a tag, publish a release, or operate another alias.

## Authorization boundary

Do not run the mutating command until the user separately confirms the exact source-to-target record printed by `preflight`. General release approval and the hosted-sync phrase `approve both` do not authorize this alias change. A confirmation for a hostname, commit, or deployment by itself is insufficient; the confirmation must name the exact alias, current Vercel project, source deployment ID and URL, target deployment ID and URL, and the plan's lowercase UUID.

The checked plan is not authorization. `--confirm-exact` is accepted only when its value is byte-for-byte equal to the record and UUID derived from that plan. The authorization includes automatic restoration of `hra.sh` to the plan's exact current-project source deployment if an acknowledged target cannot be proved. It does not authorize HRA v0, another alias, DNS, or project-domain ownership.

Execution has exactly one designated writer custodian: one supported Linux host and one operating-system account holding the authenticated Vercel and Convex sessions plus the durable state directory. The local lock cannot fence another host or account, and the alias API has no expected-source compare-and-swap. Do not run this operator or another alias writer from a second host or account while a plan or recovery is live. Other devices may inspect evidence or convey the exact confirmation, but they may not dispatch provider writes.

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

## Exact plan for the illustrated reading release

[`hra-sh-80c20f7-plan.json`](./hra-sh-80c20f7-plan.json) is the checked schema-version-1 plan. It binds:

| Role | Deployment ID | Automatic hostname | Source commit |
| --- | --- | --- | --- |
| Current source | `dpl_7pK5Y4G5G6rrNWzExGCYCjr6kMKN` | `hra-jhl2jlm30-hraness.vercel.app` | `31e5d5f3b9c1731ecc26b699796f4a9f2012d856` |
| Intended target | `dpl_5um4zKKeN7WhLT58xoycxRkeoVKZ` | `hra-rao9utssa-hraness.vercel.app` | `80c20f7b1aa06aaec4a8bc03dbea249911de4717` |

It also binds current Convex production deployment ID `5089017`, generated name `qualified-hummingbird-537`, and URL `https://qualified-hummingbird-537.convex.cloud`. The alias operator never changes Convex; exact live default-production readback is a release-authority prerequisite.

The plan's lowercase canonical UUIDv4 idempotency key is `607f32a6-98a9-4597-b54e-32e72fe32b56`. It is part of `requiredConfirmation`, so a byte-identical old phrase cannot authorize a fresh plan. Prepare a different strict plan with a fresh lowercase UUIDv4 for a later deployment. Preserve the exact source observed at preparation time and choose a different target deployment and source commit. Never edit a plan or reuse its key after its exact confirmation has been requested; discard it, preflight a replacement, and request the new UUID-bound exact confirmation.

## Provider readback contract

Use Bun 1.3.14 and an absolute Vercel CLI 58.4.0 path. Both the executable entry point and the explicit-capability test boundary reject any other Bun version before argument recovery, process-journal work, provider reads, or durable alias state mutation. The operator strips inherited Vercel tokens and project selectors, selects the stable Vercel team ID, and forces noninteractive operation through the authenticated local Vercel session. Every Vercel subprocess is authority work under the repository's Linux PID-namespace supervisor. An unsupported platform, unavailable supervisor, unproven descendant cleanup, or blocked recovery journal refuses before another provider operation. There is no process-group fallback.

Preflight and execution read the following state from the providers instead of trusting names or a prior observation:

1. Convex management API readback must prove the plan's exact numeric team, project, production deployment ID, generated name, canonical URL, `isDefault: true`, and matching project `prodDeploymentName`. The protected Convex CLI config must be a single-link regular mode-`0600` file.
2. Vercel project readback from `/v9/projects/prj_8ciIt9t9foE3utG45frRN7cxckjS` must return the exact project and team IDs and `autoAssignCustomDomains: false`.
3. Vercel deployment readback from `/v13/deployments/<deployment-id>` must prove each exact deployment ID, automatic hostname, current project ID, `READY` production state, GitHub repository ID `1343008607`, `main` ref, and plan source commit.
4. Authenticated alias readback from `/v4/aliases/hra.sh` must return one exact `(alias, projectId, deploymentId, deployment.id, deployment.url)` tuple matching the plan source or target.
5. Public `https://hra.sh/.well-known/hra.json` readback must be strict schema version 2, generation 1, product `HRA`, repository ID `1343008607`, path `hraness/hra`, version `0.1.0`, and the commit belonging to that exact alias tuple.

The protected automatic target hostname is not treated as public product evidence. Before mutation, the exact `READY` Git deployment record is the target provider evidence. After mutation, the public marker must bind `hra.sh` to the target commit; failure to prove that marker invokes recovery.

Provider output is parsed from `unknown`, bounded, and reduced to closed result fields. An accepted mutation response must contain the documented `uid`, `created`, and exact `alias: "hra.sh"` fields. The initial target response must also report `oldDeploymentId` equal to the plan source; an automatic source-restoration response must report it equal to the plan target. Missing, null, or unplanned prior authority fails closed. Do not use `--debug`, `--verbose`, `--token`, `--force`, remove-then-add, the friendly `vercel alias set` command, a DNS command, a certificate command, or a domain-move endpoint.

## Read-only preflight

Run preflight as the designated Linux writer custodian from a clean checkout containing the reviewed operator:

```sh
bun run release:canonical-alias preflight \
  --vercel-cli /absolute/path/to/vercel \
  < docs/hra-sh-80c20f7-plan.json
```

Preflight performs no provider write. It first takes the designated custodian's same machine-local lock and inspects the protected ledger. A receipt-less current intent returns `unresolved_current_intent`, and a different receipt-less intent returns `unresolved_prior_intent`, before provider readback; neither can be reclassified as already committed. Exact source authority with no terminal record returns `status: "ready"`, `nextAction: "confirm_exact_record_then_execute"`, and `requiredConfirmation`. Exact target authority returns `status: "already_committed"` only when no intent exists or a valid target receipt agrees. An unplanned alias, marker mismatch, provider mismatch, unreadable response, unsafe project setting, wrong Convex default, terminal receipt mismatch, or retired identity blocks or refuses.

A preflight is a point-in-time observation, not a provider lock. Execution repeats every read before mutation. Present the complete UUID-bound `requiredConfirmation` value and exact plan to the user, and wait for a separate confirmation of that record and plan instance.

## Checked execution

After, and only after, the user separately confirms the exact UUID-bound record printed by preflight, pass that exact value as one quoted argument:

```sh
bun run release:canonical-alias --execute \
  --vercel-cli /absolute/path/to/vercel \
  --confirm-exact '<exact requiredConfirmation from the immediately preceding preflight>' \
  < docs/hra-sh-80c20f7-plan.json
```

The only provider mutation form constructed by the operator is the documented direct `POST /v2/deployments/<exact-deployment-id>/aliases` request with the single field `alias=hra.sh`, scoped to stable Vercel team ID `team_UAd1iD2XogJlbFg4h14mRaPM`. The deployment ID is either the exact plan target or, only after an acknowledged target response and failed target proof, the exact plan source. The operator invokes that endpoint through `vercel api`; it never invokes the friendly `vercel alias set` command because that command can perform implicit domain and certificate setup beyond the one alias record. Each request carries its distinct plan- and effect-derived mutation key in an `Idempotency-Key` correlation header. The alias endpoint does not document deduplication for that header, so recovery safety does not assume provider-side idempotency. An uncertain target request is never redispatched and is never followed by an opposing source write; it becomes a durable hard stop. The request does not detach the alias first and cannot select another alias or project. After an acknowledged target response with exact prior-source provenance, the operator repeatedly reads the authenticated alias tuple and public marker for at most 60 seconds, then repeats the Vercel project, both deployment, current Convex default-production, alias, and marker readbacks before returning `status: "committed"`.

Execution derives a fixed `<system-account-home>/.local/state/hra/canonical-alias-release` directory from the operating system account record, not from an inherited `HOME`. It requires a protected mode-`0700` directory and mode-`0600`, single-link regular state files. One inode-checked machine-local advisory lock serializes every plan for that designated host and account. It is not a distributed provider lock. While holding it, the operator scans the bounded directory and refuses a new plan behind any older unresolved intent. The 4,097 persistent-entry bound reserves the lock plus complete intent-receipt pairs for 2,048 terminal plans; it cannot strand the second half of a newly admitted pair. Scan startup permits only one transient 4,098th hardlink so it can finish a proved publication interrupted after its destination link was created, then requires the recovered directory to be back within the persistent bound.

For an exact source state, the operator completes one full provider read, durably publishes and rereads a self-digested intent, repeats the full provider read, and only then dispatches the target assignment. The intent binds the exact plan, confirmation, observed source and intended target authorities, and distinct plan-bound mutation keys for target assignment and source restoration. A mutation is never dispatched after the lock identity is lost. A completed target postflight publishes and rereads a terminal target receipt before success is printed. A proved automatic restoration publishes and rereads a terminal source receipt before the non-success `alias_reverted` result is printed.

An exact target state with no durable intent is safe to classify read-only with the same plan and exact confirmation. A valid terminal target receipt is also replayed read-only. A lost or invalid target-command response is not reconciled into a commit from readback because the provider does not document request deduplication or delayed-effect cancellation. It returns `target_result_ambiguous` or a closed provider-readback failure with exit `75`. If an intent exists without any terminal receipt, every later invocation performs full readback but dispatches no mutation and returns `unresolved_current_intent`. It never infers target success, repeats target, or opposes a possibly delayed target with source.

## Recovery design

The plan's current-project source deployment is the only automatic recovery target. HRA v0 is never a fallback.

After an acknowledged target response whose `oldDeploymentId` proves the exact plan source, failure to prove the target alias tuple, target marker, or complete postflight reasserts only the plan's exact source automatic hostname on `hra.sh`. It then requires the source response to prove `oldDeploymentId` was the exact target and requires the exact source alias tuple, source commit-bearing marker, Vercel project, both current-project deployments, and current Convex production target to pass again. Proven restoration records a terminal source receipt and returns `status: "reverted"` with nonzero exit; it never reports a release commit. An ambiguous target response performs no automatic restoration because the delayed target effect cannot be ordered safely against an opposing source write.

If source restoration or readback cannot be proved, the operator returns exit `75` with `status: "recovery_required"` and `code: "compensation_failed"`. A target-response ambiguity returns `target_result_ambiguous`. A process-custody failure or recovery journal after intent publication also returns exit `75` with its exact recovery paths. Every failure after an intent may have been published is recovery-required, including a failed second authority read and `intent_write_failed`. Resolve process custody before provider reconciliation.

Durable recovery codes are closed instructions:

- `receipt_write_failed` means provider authority may already be exact target or restored source, but its terminal receipt was not proved durable. Preserve every state file. The current operator deliberately cannot infer which acknowledged or delayed phase lacks its receipt and will return `unresolved_current_intent` on the unchanged plan without a write.
- `target_result_ambiguous` means the target request returned no accepted provider response. A later exact target readback cannot prove the request's prior authority or that no delayed effect remains. Preserve the intent and perform no opposing write.
- `unresolved_current_intent` is a hard stop for the named plan. This version has no safe autonomous replay for a receipt-less intent. Recovery requires a separately reviewed, phase-aware operator revision or provider-supported ordering/CAS evidence; it is not authorized by editing or deleting the intent, reusing another UUID, or issuing a manual alias command.
- `receipt_authority_mismatch` means a terminal receipt and current provider authority disagree. Stop and investigate without another write.
- `durable_state_invalid` means the fixed directory, lock, intent, receipt, identity, digest, or bounded directory contents failed validation. Do not delete, rename, or edit the evidence to make the check pass.
- `durable_state_capacity_exhausted` is a designed stop after 2,048 terminal plan pairs. Do not remove history by hand. No new provider read or write is permitted until a reviewed operator revision adds a self-digested checkpoint or increases the bound while retaining every prior UUID and plan digest.
- `unresolved_prior_intent` means a different older plan has an intent without a terminal receipt. The error identifies that older UUID plus its exact intent and expected receipt paths. Stop behind that hard boundary. Do not start the new plan and do not delete or edit the older evidence.

For any exit `75`, stop release work, retain the unchanged plan and exact confirmation, and preserve the fixed state directory. Re-running the same plan as the same designated host and account may repeat readback, but a receipt-less intent remains a nonmutating hard stop in this operator version. Do not copy the intent to a second custodian, start a competing writer, or try a different UUID. Do not improvise a DNS change, domain move, deployment, detached alias command, HRA v0 route, new plan, or manual recovery while authority is uncertain.

After a committed result, independently repeat the filtered Vercel alias and deployment readbacks and fetch the public marker and illustrated reading pages. Those observations do not expand the original authorization and must not perform another write.
