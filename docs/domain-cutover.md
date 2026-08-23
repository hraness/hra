# HRA domain cutover

This runbook moves `hra.sh` between HRA v0 and new HRA in the `hraness` Vercel team. Traffic moves first by changing the alias to one exact accepted deployment. Project-domain ownership moves only after that traffic readback succeeds. The checked operator performs bounded probes and automatic restoration; do not substitute detached, force-based, or hand-written alias movement.

## Fixed provider identities

| Role | Vercel project ID | GitHub repository ID | Stable fallback |
| --- | --- | ---: | --- |
| HRA v0 | `prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr` | `1334876494` | `https://hra-weld.vercel.app` |
| New HRA | `prj_8ciIt9t9foE3utG45frRN7cxckjS` | `1343008607` | the project's automatic `.vercel.app` domain |

The team slug is `hraness`; its numeric ID is `team_UAd1iD2XogJlbFg4h14mRaPM`. The preserved pre-migration deployment is `dpl_AmtYwx5XmgziAxGtNFMMKLGMnXUw` at the bare automatic hostname `hra-1o6bv6wbl-hraness.vercel.app`, sourced from commit `6221f79b745f154882080936b961ff431569f33e`. It is historical evidence, not the post-migration rollback target.

Resolve every project, deployment, and repository by these numeric IDs. Stop if a provider name resolves to another ID.

## Release authority

The authenticated Vercel alias readback is the traffic authority. Its exact `(projectId, deploymentId, deployment.id, deployment.url)` tuple must identify the accepted deployment:

```sh
vercel api /v4/aliases/hra.sh --scope hraness --raw | jq -c '{alias,projectId,deploymentId,deployment:{id:.deployment.id,url:.deployment.url}}'
```

`https://hra.sh/.well-known/hra.json` is independent product evidence. Generation 0 must identify repository ID `1334876494`, path `hraness/hra-v0`, and the exact accepted archive source commit. Generation 1 must identify repository ID `1343008607`, path `hraness/hra`, and the exact accepted new-HRA source commit. Both markers carry `source.commit` and version. A marker does not replace the deployment-ID readback because two deployments can share source and version.

Record only filtered provider fields. Full deployment and alias responses can contain operator identity data. Do not use `--debug`, `--verbose`, `--token`, `--force`, remove-then-add, or a token-bearing shell variable.

## Prepare accepted deployments

Use Vercel CLI `54.18.0`. The operator requires an absolute CLI path and refuses another reported version. Read each deployment with `/v13/deployments/<id>` and record only:

```sh
vercel api /v13/deployments/<deployment-id> --scope hraness --raw | jq -c '{id,url,projectId,readyState,gitSource:{ref:.gitSource.ref,repoId:.gitSource.repoId,sha:.gitSource.sha,type:.gitSource.type}}'
```

Require `readyState` to be `READY`, `gitSource.type` to be `github`, `gitSource.ref` to be `main`, and the project ID, repository ID, source commit, deployment ID, and bare automatic hostname to match the accepted release. A bare automatic hostname already ends in `.vercel.app`; never append that suffix again.

Prepare these exact endpoints:

- P: the preserved baseline deployment above.
- Q: a new `READY` HRA v0 archive deployment built from the merged, protected `hraness/hra-v0` main commit. Q becomes the rollback target.
- N: a new `READY` HRA deployment built from the protected `hraness/hra` main commit accepted by all gates.

Verify Q and N through their automatic hostnames before changing `hra.sh`. Check root, privacy, `robots.txt`, `sitemap.xml`, `llms.txt`, `.well-known/security.txt`, `.well-known/hra.json`, TLS, response headers, and release-specific acceptance surfaces. Q must also serve the compatibility and immutable release-history pages. Exercise hosted health and acceptance on N.

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

The operator strips inherited Vercel-token variables and uses the authenticated local Vercel session. Before any mutation it verifies both deployments, the exact current alias tuple, the current public marker when one exists, and project-domain ownership. It then:

1. Points `hra.sh` at the target's bare automatic hostname.
2. Probes the exact alias tuple and commit-bearing marker for at most 60 seconds.
3. Restores the exact previously proven source deployment if the command fails, readback is wrong, or public convergence times out.
4. For domain plans only, moves ownership in one API request after traffic is proven.
5. Reads both project domain lists, the alias tuple, and marker again before reporting `committed`.

Every failed or uncertain traffic change enters automatic restoration. If source restoration itself cannot be proven within 60 seconds, the operator reports `compensation_failed`; stop all release work and escalate. Never continue to a repository rename, tag, release, or invitation after a refused result.

The only ownership mutation endpoints are the symmetric numeric-ID moves below. The operator constructs these calls after its traffic gate; they are shown for audit, not manual execution:

```text
/v1/projects/prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr/domains/hra.sh/move -> prj_8ciIt9t9foE3utG45frRN7cxckjS
/v1/projects/prj_8ciIt9t9foE3utG45frRN7cxckjS/domains/hra.sh/move -> prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr
```

## Archive deployment transition

Run the `archive` traffic-only plan P → Q after the old repository rename, protected merge, and exact-Q deployment. This replaces the pre-migration deployment with the accepted compatibility deployment without moving project ownership. Independently repeat the exact `/v4/aliases/hra.sh` readback and generation-0 marker check. Verify `https://hra-weld.vercel.app` still works.

Q is now the only rollback source used by forward, reverse, and incident plans. P remains unchanged and readable by deployment ID as historical evidence.

## Forward rehearsal

Run the `forward` plan Q → N. Independently read both domain lists:

```sh
vercel api /v9/projects/prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr/domains --scope hraness --raw | jq -c '{domains:[.domains[]|{name}]}'
vercel api /v9/projects/prj_8ciIt9t9foE3utG45frRN7cxckjS/domains --scope hraness --raw | jq -c '{domains:[.domains[]|{name}]}'
```

Require `hra.sh` exactly once under new HRA and zero times under HRA v0. Repeat the exact alias query, generation-1 marker, full public acceptance, and `https://www.hra.sh` redirect check.

## Reverse rehearsal

Run the `reverse` plan N → Q. Require `hra.sh` exactly once under HRA v0, the exact Q alias tuple, generation-0 marker, old root, compatibility page, release downloads, privacy, security policy, and fallback. Both projects' automatic hostnames must retain their own generation markers.

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

1. Prove Q and `https://hra-weld.vercel.app` healthy, then read P separately by ID.
2. Run N → Q and require a `committed` JSON result.
3. Independently verify exact Q alias, marker, and domain ownership.
4. Disable new hosted invitations and credentials without changing HRA v0 data or provider state.
5. Keep `hraness/hra` and every published tag intact. Repair forward on a new protected current-head commit, deploy it, rehearse both directions, and cut over again.
