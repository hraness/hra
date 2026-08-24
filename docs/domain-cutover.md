# HRA domain cutover

This runbook moves `hra.sh` between HRA v0 and new HRA in the `hraness` Vercel team. Traffic moves first by changing the alias to one exact accepted deployment. Project-domain ownership moves only after that traffic readback succeeds. The checked operator performs bounded probes and automatic restoration; do not substitute detached, force-based, or hand-written alias movement.

## Fixed provider identities

| Role | Vercel project ID | GitHub repository ID | Stable fallback |
| --- | --- | ---: | --- |
| HRA v0 | `prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr` | `1334876494` | `https://hra-weld.vercel.app` |
| New HRA | `prj_8ciIt9t9foE3utG45frRN7cxckjS` | `1343008607` | `https://try-hra.vercel.app` |

The team slug is `hraness`; its numeric ID is `team_UAd1iD2XogJlbFg4h14mRaPM`. The preserved pre-migration deployment is `dpl_AmtYwx5XmgziAxGtNFMMKLGMnXUw` at the bare automatic hostname `hra-1o6bv6wbl-hraness.vercel.app`, sourced from commit `6221f79b745f154882080936b961ff431569f33e`. It is historical evidence, not the post-migration rollback target.

Resolve every project, deployment, and repository by these numeric IDs. Stop if a provider name resolves to another ID.

## Release authority

The authenticated Vercel alias readback is the traffic authority. Its exact `(projectId, deploymentId, deployment.id, deployment.url)` tuple must identify the accepted deployment:

```sh
vercel api /v4/aliases/hra.sh --scope hraness --raw | jq -c '{alias,projectId,deploymentId,deployment:{id:.deployment.id,url:.deployment.url}}'
```

`https://hra.sh/.well-known/hra.json` is independent product evidence. Generation 0 must identify repository ID `1334876494`, path `hraness/hra-v0`, the exact accepted archive source commit, and the archive version at `publication.version`. Generation 1 must identify repository ID `1343008607`, path `hraness/hra`, the exact accepted new-HRA source commit, and its top-level `version`. Both schema-version-2 markers carry `source.commit`; their generation-discriminated version locations are intentional. A marker does not replace the deployment-ID readback because two deployments can share source and version.

Record only filtered provider fields. Full deployment and alias responses can contain operator identity data. Do not use `--debug`, `--verbose`, `--token`, `--force`, remove-then-add, or a token-bearing shell variable.

## Disable automatic domain assignment

Disable automatic custom-domain assignment on both fixed projects before staging Q or N. This setting prevents a Git-triggered or production deployment from silently reassigning `hra.sh`, `hra-weld.vercel.app`, or `try-hra.vercel.app` outside the checked cutover sequence. Address the projects by numeric ID:

```sh
vercel api /v9/projects/prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr --scope hraness -X PATCH -F autoAssignCustomDomains=false --silent
vercel api /v9/projects/prj_8ciIt9t9foE3utG45frRN7cxckjS --scope hraness -X PATCH -F autoAssignCustomDomains=false --silent
```

Read both records back independently:

```sh
vercel api /v9/projects/prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr --scope hraness --raw | jq -c '{id,accountId,autoAssignCustomDomains}'
vercel api /v9/projects/prj_8ciIt9t9foE3utG45frRN7cxckjS --scope hraness --raw | jq -c '{id,accountId,autoAssignCustomDomains}'
```

Require the requested project ID to equal the returned `id`, `accountId` to equal numeric team ID `team_UAd1iD2XogJlbFg4h14mRaPM`, and `autoAssignCustomDomains` to be exactly `false` for both records. A missing field, `true`, another value, a project- or team-identity mismatch, or an unreadable response is a stop condition. Keep the setting disabled through archive staging, both rehearsals, and final production cutover.

## Prepare accepted deployments

Use Vercel CLI `54.18.0`. The operator requires an absolute CLI path and refuses another reported version. Read each deployment with `/v13/deployments/<id>` and record only:

```sh
vercel api /v13/deployments/<deployment-id> --scope hraness --raw | jq -c '{id,url,projectId,readyState,gitSource:{ref:.gitSource.ref,repoId:.gitSource.repoId,sha:.gitSource.sha,type:.gitSource.type}}'
```

Require `readyState` to be `READY`, `gitSource.type` to be `github`, `gitSource.ref` to be `main`, and the project ID, repository ID, source commit, deployment ID, and bare automatic hostname to match the accepted release. A bare automatic hostname already ends in `.vercel.app`; never append that suffix again. The deployment URL is an exact provider identity and alias destination, not proof that an unauthenticated browser can reach it. Deployment protection can cover automatic deployment URLs.

Stage a source upload without automatic alias promotion, even after disabling the project setting:

```sh
vercel deploy <project-path> --prod --skip-domain --project <fixed-project-id> --scope hraness
```

Do not accept a source-uploaded Q or N deployment created by a command that omitted `--skip-domain`. A deployment created from Vercel's immutable Git source may instead be rebuilt with `vercel redeploy <exact-git-deployment-id> --target production` when the original build failed before release, but only after independently proving its exact `gitSource` tuple and reading `autoAssignCustomDomains === false` immediately before and after the rebuild. `vercel redeploy` has no `--skip-domain` option. The resulting deployment remains acceptable only when it preserves the exact GitHub repository ID, `main` ref, source commit, project ID, and disabled custom-domain setting. A CLI source upload whose deployment record has `gitSource: null` is not a Q or N candidate even when its Git metadata strings look correct.

Inspect Q and N before exposing them through a public custom alias with the authenticated local Vercel session:

From the fixed, mode-`0700` linked operator directory whose `.vercel/project.json` names the exact numeric project, run:

```sh
vercel curl / --deployment <deployment-id>
vercel curl /.well-known/hra.json --deployment <deployment-id>
```

Vercel CLI `54.18.0` forwards `--scope` to its nested curl process even when written as a global option, so do not add it to `vercel curl`. The protected fixed link supplies project and team identity; the separate deployment and project API readbacks remain authoritative.

Use `vercel curl --deployment` for every release-specific path needed by acceptance. Do not pass, print, save, or script a protection-bypass secret. These authenticated checks do not replace the later public custom-alias probes.

Prepare these exact endpoints:

- P: the preserved baseline deployment above.
- Q: a new `READY` HRA v0 archive deployment built from the merged, protected `hraness/hra-v0` main commit. Q becomes the rollback target.
- N: a new `READY` HRA deployment built from the protected `hraness/hra` main commit accepted by all gates.

Q must pass authenticated root, privacy, `robots.txt`, `sitemap.xml`, `llms.txt`, `.well-known/security.txt`, `.well-known/hra.json`, response-header, compatibility, immutable-release-history, and release-download checks. The archive operator subsequently gives Q a public check at `hra-weld.vercel.app` before it changes `hra.sh`.

Assign N to the fixed new-HRA staging alias only after its authenticated checks pass:

```sh
vercel alias set <N-bare-automatic-hostname> try-hra.vercel.app --scope hraness
vercel api /v4/aliases/try-hra.vercel.app --scope hraness --raw | jq -c '{alias,projectId,deploymentId,deployment:{id:.deployment.id,url:.deployment.url}}'
```

Require the tuple to identify new project ID `prj_8ciIt9t9foE3utG45frRN7cxckjS` and exact N deployment ID and URL. Publicly check the generation-1 marker, root, privacy, security, TLS, headers, hosted health, and release acceptance at `https://try-hra.vercel.app`. The checked operator refuses a forward or reverse plan unless this fixed alias still identifies exact N and its commit-bearing marker.

## Checked operator

`hosted:domain-cutover` reads one strict schema-version-1 JSON plan from protected stdin or `--plan-fd`, emits one JSON result, and requires `--execute`. Each endpoint contains:

```json
{
  "deploymentId": "dpl_<exact-id>",
  "deploymentUrl": "<bare-automatic-hostname>.vercel.app",
  "generation": 1,
  "projectId": "prj_<exact-id>",
  "repositoryId": 1343008607,
  "sourceCommit": "<40-lowercase-hex-commit>",
  "version": "0.1.0"
}
```

Plans add `schemaVersion`, `direction`, `mode`, `source`, and `target`. Only these identity mappings are valid:

| Direction | Mode | Source | Target |
| --- | --- | --- | --- |
| `archive` | `traffic-only` | P, old project, `generation: null` | Q, old project, generation 0 |
| `forward` | `domain` | Q, old project, generation 0 | N, new project, generation 1 |
| `reverse` | `domain` | N, new project, generation 1 | Q, old project, generation 0 |

Run a checked plan with Bun 1.3.14:

```sh
bun run hosted:domain-cutover --execute --vercel-cli /absolute/path/to/vercel < cutover-plan.json
```

The operator strips inherited Vercel-token variables and uses the authenticated local Vercel session. Before any mutation it verifies `autoAssignCustomDomains === false` on both fixed numeric projects, both deployments, the exact current alias tuple, the current public marker when one exists, and project-domain ownership. Domain plans additionally require `hra-weld.vercel.app` to identify exact Q and `try-hra.vercel.app` to identify exact N, including their public commit-bearing markers. It refuses before reading or changing traffic if either project setting or fixed staging alias is unsafe. It then:

1. For an archive plan, points `hra-weld.vercel.app` at Q and proves its exact alias tuple and generation-0 marker before touching `hra.sh`.
2. Points `hra.sh` at the target's bare automatic hostname.
3. Probes the exact alias tuple and commit-bearing marker for at most 60 seconds.
4. Restores and proves every exact previously accepted traffic alias if the command fails, readback is wrong, or public convergence times out. Domain compensation proves the canonical alias, Q fallback, and N staging alias before it attempts an ownership reversal or reports ambiguous ownership. Archive compensation restores both fixed old-HRA aliases to P.
5. For domain plans only, moves ownership in one API request after traffic is proven.
6. Reads both project domain lists with explicit 20-record pages. Every page must carry a matching item count and a valid next cursor. The operator follows unseen cursors until it receives an explicit terminal `next: null`, and refuses missing pagination, repeated cursors, empty nonterminal pages, or more than 64 pages. It then re-proves the canonical, old fallback, and new staging alias tuples and markers before reporting `committed`.

The same exact plan is safe to replay after interruption or a lost result. The operator classifies the complete provider state only after re-reading both projects and both deployments. An exact target state succeeds without another mutation only after the canonical target, its commit-bearing marker, the fixed Q fallback, the fixed N staging alias, and domain ownership all pass again. Archive source, target, replay, and compensation states require `hra.sh` to remain owned exactly once by the fixed HRA v0 project and never by the new project. Its receipt reports `changed: false` and `replayed: true`. A normal source-to-target transition reports `changed: true` and `replayed: false`. A partial archive or domain state is never accepted as a replay: the operator restores the full exact source state, including both fixed staging aliases, and returns `cutover_reverted`, so a later invocation can begin from the proved source. Missing, duplicate, or unknown ownership remains an escalation condition.

Every failed or uncertain traffic change enters automatic restoration. If source restoration itself cannot be proven within 60 seconds, the operator reports `compensation_failed`; stop all release work and escalate. Never continue to a repository rename, tag, release, or invitation after a refused result.

The only ownership mutation endpoints are the symmetric numeric-ID moves below. The operator constructs these calls after its traffic gate; they are shown for audit, not manual execution:

```text
/v1/projects/prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr/domains/hra.sh/move -> prj_8ciIt9t9foE3utG45frRN7cxckjS
/v1/projects/prj_8ciIt9t9foE3utG45frRN7cxckjS/domains/hra.sh/move -> prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr
```

## Archive deployment transition

Run the `archive` traffic-only plan P → Q after the old repository rename, protected merge, authenticated exact-Q acceptance, and exact-Q deployment readback. Before the plan, require both public old-HRA aliases to identify P:

```sh
vercel api /v4/aliases/hra-weld.vercel.app --scope hraness --raw | jq -c '{alias,projectId,deploymentId,deployment:{id:.deployment.id,url:.deployment.url}}'
vercel api /v4/aliases/hra.sh --scope hraness --raw | jq -c '{alias,projectId,deploymentId,deployment:{id:.deployment.id,url:.deployment.url}}'
```

The operator first moves only `hra-weld.vercel.app` from P to Q. It requires the fallback alias tuple to identify the old numeric project and exact Q deployment ID and URL, then fetches the fallback marker without cached evidence and requires generation 0, repository ID `1334876494`, path `hraness/hra-v0`, Q's `source.commit`, and Q's version. Only after that proof does it move `hra.sh` from P to Q. Any ambiguous command, tuple mismatch, marker failure, or timeout restores both aliases to exact P and returns a refusal.

After a committed result, independently repeat the exact readbacks for both aliases. Check the fallback's root, compatibility pages, release downloads, privacy, security policy, TLS, and headers, then repeat the generation-0 marker and canonical surface checks on `hra.sh`. This transition does not move project ownership.

Q is now the only rollback source used by forward, reverse, and incident plans. P remains unchanged and readable by deployment ID as historical evidence.

## Forward rehearsal

Run the `forward` plan Q → N. Independently read both domain lists:

```sh
vercel api '/v9/projects/prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr/domains?limit=20' --scope hraness --paginate --raw | jq -c '{domains:map({name})}'
vercel api '/v9/projects/prj_8ciIt9t9foE3utG45frRN7cxckjS/domains?limit=20' --scope hraness --paginate --raw | jq -c '{domains:map({name})}'
```

The pinned CLI's `--paginate` mode follows the provider cursor to its terminal page and emits the combined domain array. Require `hra.sh` exactly once under new HRA and zero times under HRA v0. A non-paginated first page is not ownership evidence. Repeat the exact alias query, generation-1 marker, full public acceptance, and `https://www.hra.sh` redirect check.

## Reverse rehearsal

Run the `reverse` plan N → Q. Require `hra.sh` exactly once under HRA v0, the exact Q alias tuple, generation-0 marker, old root, compatibility page, release downloads, privacy, security policy, and fallback. Require `hra-weld.vercel.app` to remain exact Q and `try-hra.vercel.app` to remain exact N with their own generation markers. Recheck P, Q, and N by deployment ID with authenticated `vercel curl --deployment`; do not use unauthenticated automatic-hostname responses as evidence.

The rehearsal passes only after archive, forward, and reverse plans all commit and their independent readbacks pass. Repeat the forward plan and acceptance checks for production. Publish no immutable new-HRA tag until the final forward move is exact.

## Ambiguous move decisions

The operator resolves the alias and project-domain lists together after every move attempt:

| Alias readback | Domain owner | Result |
| --- | --- | --- |
| alias target, domain target | Commit only after target marker passes again. |
| alias target, domain source | Move did not commit; restore the source alias and stop. |
| alias source, domain target | Traffic is safe; reverse ownership from the exact target to source and stop. |
| alias source, domain source | Restore/read source and stop as not committed. |
| missing, duplicate, unknown, or unreadable | Force traffic back to the exact source first. Reverse metadata only when readback proves the exact target owns it; otherwise stop and escalate. |

This decision table is symmetric, so it applies to forward and reverse movement. Domain metadata never outranks the exact alias deployment mapping for traffic safety.

## Incident rollback after release

Repository names and immutable tags do not roll back. Traffic can return to HRA v0 with the checked `reverse` plan:

1. Freeze new hosted authentication admission on the exact new-HRA Convex deployment before moving public traffic. Read the current generation, choose one UUIDv7, and preserve that safe replay tuple in the private incident record:

   ```sh
   bun run hosted:admission -- status <exact numeric target arguments>
   bun run hosted:admission -- freeze --expected-generation <generation> --mutation-id <uuidv7> <exact numeric target arguments>
   ```

   The checked operator verifies the numeric team, project, deployment, production type, generated name, URL, and default-production binding before and after the mutation. Freeze blocks new identity invites, OTP requests and verification, auth session creation or refresh, and new device credentials. Existing reads, account deletion, device revocation, maintenance, and an exact replay of a registration already committed before the freeze remain available. A lost response is recovered only by repeating the same generation and UUIDv7. Do not rotate JWT, HMAC, email, or device keys as an incident shortcut.
2. Prove Q and `https://hra-weld.vercel.app` healthy, then read P separately by ID. A failed Q proof leaves new-HRA admission frozen and public traffic unchanged.
3. Run N → Q and require a `committed` JSON result. If reversal fails, keep admission frozen while the checked operator restores or proves the last safe traffic state.
4. Independently verify exact Q alias, marker, and domain ownership.
5. Revoke every still-live invitation by its recorded public ID with the checked invitation operator. Revoke a suspect device from another active device or begin authenticated account deletion for a compromised identity.
6. Resume admission only after a fixed forward release passes the full live gate. Read the frozen generation, choose a new UUIDv7, and require the explicit resume acknowledgement:

   ```sh
   bun run hosted:admission -- resume --expected-generation <generation> --mutation-id <uuidv7> --acknowledge-resume <exact numeric target arguments>
   ```
7. Keep `hraness/hra` and every published tag intact. Repair forward on a new protected current-head commit, deploy it, rehearse both directions, and cut over again.
