---
title: Hraness delivery autonomy
description: Active plan for reducing routine Codex, Claude Code, npm, and GitHub approval interruptions without weakening repository or provider gates.
type: plan
status: active
area: operations
tags:
  - agents
  - codex
  - claude
  - github
  - npm
  - release
relations:
  related-to: [ plans/hra-v1, plans/hra-v2 ]
---

# Hraness delivery autonomy

Status: active, revision 4 (2026-09-08). The machine-confidence foundation, current-Mac
bootstrap and HRA, Oh and personal-monorepo-template pilots are delivered. Wider fleet
adoption and provider-specific rollout remain separately tracked; they do not reopen the
completed foundation or block an independently admitted artifact.

## Outcome

Routine, task-owned repository delivery should run to completion without asking a person to
repeat authority they already granted. Implementation, commits, pushes, pull requests, merges,
tags, releases, deployments, and production verification remain subject to each repository's
required checks and provider controls, but those controls should use review, protected refs, and
short-lived workload identities instead of conversational confirmation, personal tokens, or a
per-release administrator setting.

The broader roadmap is complete when:

1. Codex uses workspace-scoped permissions with automatic approval review, and Claude Code uses
   Auto mode, from one deterministic machine bootstrap that preserves unrelated user settings and
   removes broad explicit allow rules that would bypass Auto's classifier.
2. Every Hraness repository has the same marker-managed authority and safety policy in
   `AGENTS.md`, while root `CLAUDE.md` imports that policy without replacing project-specific
   Claude guidance.
3. npm releases after a package's one-time bootstrap use GitHub Actions trusted publishing and
   provenance. Where provider policy permits direct publication, routine releases need no npm
   password, OTP, recovery code, personal write token, staged-publication approval, or mutable
   repository approval variable. Provider-required approval stays bound to the exact staged
   artifact and retains its required authentication. A release
   tag command binds an immutable owner identity to the exact protected-main commit and successful
   CI receipt before any provider mutation. A future dedicated release App may replace that local
   principal only when its credential is isolated from repository-controlled workflows.
4. Same-repository GitHub automation uses `GITHUB_TOKEN`; bounded cross-repository automation uses
   a narrowly installed GitHub App token. Routine delivery never refreshes a person's `gh` login
   or changes repository administration settings.
5. A read-only audit reports machine and repository drift, and the same bootstrap and adoption
   commands converge that drift without rewriting unrelated configuration.

## Evidence

The reviewed machine-confidence policy merged through
[HRA PR156](https://github.com/hraness/hra/pull/156) as
`b856c66113c9a8752dbb431fc578287c23279cfe`. Its canonical policy assets,
operator guidance and regression tests preserve the distinction between artifact
admission, live qualification and operational activation. The installed
`hra-local-efficiency` 0.4.0 baseline passed its local apply/check and subsequent
readback on 2026-09-08. This proves that Mac's configuration, not runtime account
eligibility or every development machine.

The marker-only pilots merged through [Oh PR45](https://github.com/hraness/oh/pull/45)
and [personal-monorepo-template PR12](https://github.com/hraness/personal-monorepo-template/pull/12),
with their own required checks and fresh main CI passing. Oh's exact merge
`fd3a0d7d734c0f0d2d88d606329055c3a938ba93` preserved reviewed tree
`a24fab03d3a7128c3a0a834cd99ee314aa35bd6c`; its code-owner setting was unchanged
at merge. The separately reviewed [Oh issue46](https://github.com/hraness/oh/issues/46)
change followed at 20:26:02Z on 2026-09-08 and changed only required code-owner
review from true to false. Strict required checks, resolved review threads,
squash-only delivery and protected refs remain. That change was not needed for
the guidance pilot's merge and did not alter its source.

These are completed foundation and pilot receipts, not fleet-wide completion,
package admission or hosted activation. HRA's exact artifact status and per-release
evidence remain in the [release record](../../docs/beta-release.md).

### Historical audit basis

The fleet audit found that repository guidance already has one HRA-managed insertion point, but
Claude did not consume it in most repositories because Claude Code reads `CLAUDE.md`, not
`AGENTS.md`. The machine bootstrap managed Codex guidance and scheduling but not Codex's reviewer
default, Claude's permission mode, or Claude's global instructions.

The release audit found three distinct interruption sources:

- HRA already uses npm OIDC but added a mutable repository-variable approval for every version.
- Wrench uses npm staged publishing, whose public admission deliberately requires human 2FA for
  every version.
- Soundfish documents a local `npm publish`, binding routine release to a maintainer session.

The existing exact-artifact checks, protected-main ancestry, workload-identity checks, provenance,
and public readback are stronger release evidence than a second string-valued approval switch.
They remain mandatory.

## Decisions

### D1. Automate review, not trust boundaries

Codex keeps interactive `on-request` approval semantics and the `:workspace` permission profile,
but routes eligible requests to `auto_review`. Claude Code uses Auto mode. Neither baseline uses
full filesystem access, `never` approvals, bypass-permissions flags, or an unconditional allow rule
for an arbitrary command wrapper. On Auto-mode adoption, bare whole-tool allows and every
wildcarded Bash or PowerShell allow are removed because explicit allows resolve before the
classifier; exact command rules, path-bounded non-shell rules, and denies remain in configuration.
Claude may apply additional runtime filtering. Runtime-enforced denials remain binding.

### D2. Record standing authority once

The user request that places a repository and outcome in scope authorizes ordinary task-owned
delivery through the repository's documented workflow. Agents do not ask again before a commit,
push, pull request, merge, tag, release, deploy, or verification step already entailed by that
request. They stop only for a material product decision, missing credential or authority, an
irreversibly destructive action outside scope, or a failure that cannot be reconciled safely.

Unavoidable interactive authentication is collected at the last responsible boundary and batched
into one explicit request naming every affected provider object. It is never converted into a
long-lived secret merely to avoid a prompt.

### D3. Workload identities publish releases

Existing npm packages use [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
from an exact GitHub repository, workflow file, and optional protected environment. The job grants
only `contents: read` plus `id-token: write` unless another reviewed release effect needs a narrow
permission. A package's first publication remains a one-time maintainer ceremony because npm
cannot attach a trusted publisher to a coordinate that does not yet exist.

Use direct publication where npm permits it. The [npm dual-use policy](https://docs.npmjs.com/policies/dual-use/)
requires interactive publication or staged-artifact promotion for packages subject to that
policy. Preserve the package declaration and exact staged bytes, complete all automated
validation first, and batch the required authentication at that boundary. Do not remove a
declaration, rename a package, or change channels to evade provider controls. Hraness does not
adopt bypass-2FA granular access tokens to eliminate prompts.

### D4. Beta is a version lane, not a retag ceremony

Where provider policy permits unattended publication, high-frequency agent releases use unique semantic prerelease versions such as
`1.4.0-beta.27` with `npm publish --tag beta`. Stable release trains publish a new stable version
with `--tag latest` after the repository's required review and checks. A prerelease is never
"promoted" by moving a dist-tag, because trusted publishing does not authorize dist-tag mutation
and that operation would restore a human 2FA dependency. Where registry-level isolation between
channels is essential, use separate package coordinates rather than trusting a tag convention.

### D5. Eliminate GitHub sudo triggers from the steady state

GitHub's web sudo window is a fixed security boundary, so Hraness reduces its frequency by moving
routine effects out of administrator pages. Same-repository Actions use the automatic
[`GITHUB_TOKEN`](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication),
and cross-repository automation uses short-lived
[`GitHub App installation tokens`](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
Rulesets, environments, trusted-publisher bindings, and App installation scope are configured in
one batched setup ceremony and then treated as drift-controlled infrastructure.

### D6. Match machine evidence to the effect

Build confidence through programmatic checks and independent agent review, not repeated human
confirmation. A task's standing authority covers ordinary delivery; technical confidence does not
grant additional authority. When evidence is missing, first gather bounded diagnostics, reproduce
the behavior, or obtain independent review. Ask a person only for a material unresolved decision,
unavoidable authentication, missing authority, or an out-of-scope destructive effect.

Artifact admission and operational activation are distinct decisions. Admit published artifacts
only after exact-source CI, relevant deterministic and security checks, package/install verification,
protected identity, provenance, and immutable public readback. Authenticated live qualification is
not a universal publication prerequisite. Record an unperformed proof as pending, and retain
unsupported-platform refusals and disabled or fail-closed unqualified behavior. If publication or
the artifact's install, upgrade, or default-use path activates risky unqualified behavior, isolate
that effect or prove its required conditions before shipping; artifact-only wording cannot disguise
an operational mutation.

Deployments, migrations, daemon upgrades, and provider effects keep their relevant machine-enforced
identity, target, capacity, custody, compatibility, and recovery checks. Automate these checks where
possible. Do not require a person merely to approve a passing result or convert absent test accounts
into a blanket artifact-release hold. Explicit user acceptance requirements remain binding unless
the user changes them. Replace an obsolete repository gate through a reviewed policy/source change,
never by silently skipping a failing gate during delivery.

For HRA v0.7.0, the owner's 2026-09-08 policy change removes authenticated Claude and two-device
hosted-memory qualification from tag/publication prerequisites. It does not claim those proofs
passed or permit hosted activation, a daemon upgrade, or new Claude platform support. The current
[release procedure](../../docs/beta-release.md) is authoritative; older checkpoint holds are history.

### D7. Preserve data and remove unnecessary serial work

Autonomous production delivery first binds the exact account, environment, deployment, and
data target. Data changes require an inspected dry run or equivalent migration plan and a
validated recovery path before any effect that could lose or corrupt data. Prefer additive,
backward-compatible migrations and bounded batches. Record intent, use idempotency or
conditional writes, reconcile uncertain results before retrying, and finish with deployed
identity, health, and relevant data-invariant readback. Routine delivery does not authorize
resetting, truncating, dropping, or overwriting user data.

Choose merge queues and additional approval stages only when they address a demonstrated
coordination or safety need. Prefer current integration-candidate checks, independent agent
review, and atomic or conditional integration. Replace redundant waits and checks through
reviewed policy changes with evidence for the integrated result; do not skip an existing gate.

HRA's [final validation policy](../../CONTRIBUTING.md#final-validation) assigns the complete
required CI gate as the final source aggregate for independently reviewed documentation and
guidance changes, version-only plugin metadata, and corresponding prose assertions. Focused
local contracts and existing CI coverage/equivalence tests still run. The final PR head and
current-base integration candidate need fresh matching CI evidence. Other changes retain the
local full gate, and explicit local, native, live, installation, and delivery acceptance remains
separate. This removes a duplicate execution without changing CI command coverage.

## Workstreams

| Workstream | State | Acceptance evidence |
| --- | --- | --- |
| Machine baseline on the current Mac | Complete | Reviewed 0.4.0 installation, fixture coverage, local `--apply`/`--check` and fresh configuration readback passed; other machines and runtime eligibility are separate. |
| Canonical repository policy and pilots | Complete | Managed-block tests preserve custom guidance and Claude imports; HRA PR156, Oh PR45 and template PR12 delivered through their own gates. |
| HRA npm path | Delivered | The machine publication path is delivered without the mutable publication variable; exact tag, artifact, OIDC, provenance and final admission remain required for each release in [the release record](../../docs/beta-release.md). |
| Wrench npm path | Provider-constrained | Preserve its dual-use declaration and exact staged-artifact approval with required authentication. Automate preparation, validation, staging, and readback; direct OIDC publication is not an available replacement for the provider gate. |
| Soundfish npm path | Delivered | The direct OIDC workflow completed in [release run 34059355173](https://github.com/hraness/soundfish/actions/runs/34059355173). Routine publication has a supported workload identity; future releases retain their exact-artifact gates. |
| Wider fleet rollout | Continuing | Remaining repositories and machines require their own scoped adoption and gates. No all-fleet current-state claim is made; preserve dirty primary worktrees. |
| Provider setup | Evidence-driven | Ordinary npm publication workflows are present. Change trust, account, GitHub App, or ruleset configuration only for an individually verified remaining gap; no blanket trust update is pending. |
| Machine-confidence foundation | Complete | HRA PR156 delivered the reviewed canonical global/repository assets, operator guidance and regression tests separating artifact admission from operational activation. |
| Bounded foundation propagation | Complete | Current-Mac installation and readback plus owner-coordinated HRA, Oh and template delivery are proved. Further fleet propagation is the separate workstream above. |
| Data-preserving delivery policy | In progress | Local-efficiency 0.4.1 source adds D7 and provider-permitted unattended stable delivery. CI exposed separate hardlink-read and fixture-lifecycle defects now included in the change. Focused regressions, independent review, the local full aggregate, fresh complete required CI including browser acceptance, delivery, and installation readback remain required. |

## Guardrails

- Preserve applicable required checks, protected refs, provenance assertions, release readback, and
  provider access controls. Revise obsolete human or live-qualification release prerequisites through
  reviewed policy changes with explicit replacement evidence, not ad hoc execution bypasses.
- Never store npm OTPs, npm passwords, session cookies, recovery codes, GitHub browser sessions,
  passkeys, or personal access tokens in repositories, task files, transcripts, or agent memory.
- Do not let an agent create a PAT, GitHub App, secret, trusted-publisher relationship, or wider
  permission scope unless that exact trust change is part of the task.
- Preserve dirty user work. Fleet rollout uses clean branches or isolated worktrees from exact
  fetched default-branch commits.
- Record the final branch, pull request, checks, merge, release, deployment, and production
  evidence that applies; silence is never proof of completion.

## Progress log

- 2026-09-09: exact-candidate CI exposed two delivery reliability defects after
  the guidance-only candidate had passed. Browser handoff reads now validate the
  physical parent and retain exact no-follow leaf identity, so a valid hardlink
  is not rejected when canonicalization returns its staged alias. Leaf and
  ancestor symlinks, changed identities, partial bytes, and replacement of
  write-once records remain rejected. Actor compatibility now uses
  independently bounded cases with joined fixture ownership to
  prevent timeout cleanup from deleting a setup still in progress. These
  executable and test changes require the local full aggregate and fresh
  complete CI; the guidance-only exception does not apply. Delivery remains
  pending that evidence.

- 2026-09-08: HRA's reviewed documentation/guidance validation path now uses
  focused local contracts plus fresh complete required CI as its final source
  aggregate. CI still covers every full-gate command on macOS and Linux, with
  command-coverage and shard-equivalence regressions unchanged. Runtime and other
  executable changes retain the local full gate. Fresh CI for the updated source
  and installation readback remain pending.

- 2026-09-08, revision 4: the 0.4.1 policy update adds data-preserving autonomous
  delivery and proportional integration gates. It removes the generic recommendation
  to batch routine human-gated promotions, while retaining provider-required staged
  approval. The Wrench direct-publication proposal is withdrawn because its dual-use
  policy requires interactive admission. Source delivery and installation are pending.

- 2026-09-08, foundation and pilot closeout: HRA PR156 merged the reviewed D6
  policy and tests; local-efficiency 0.4.0 installation, bootstrap check and fresh
  current-Mac readback passed. Oh PR45 and personal-monorepo-template PR12 merged
  through their required checks and passed fresh main CI. Oh issue46 separately
  aligned code-owner sign-off after the pilot merge without changing source or
  the remaining controls. This completes the scoped foundation and pilots, not
  every fleet or provider workstream. Per-release artifact status remains in the
  HRA release record; explicit live and operational guards are unchanged.

- 2026-09-08: adopted D6 at the owner's direction. HRA's mandatory pre-publication live qualification
  is being separated from machine-gated artifact admission. Shared policy assets propagate the same
  principle without changing sandbox, automatic-review, scheduler, or provider authority boundaries.

- 2026-09-04: audited the local Codex and Claude approval posture, the Hraness repository fleet,
  and every observed npm publication path; adopted D1-D5.
- 2026-09-04: began the managed machine baseline, repository adoption extension, and removal of
  HRA's redundant publication variable.
- 2026-09-04: rejected a same-repository Actions tag broker after review proved that its generic
  integration bypass was reachable by collaborator-controlled workflow files. Replaced it with a
  fail-closed owner-local tag command for exact CI-green current `main`; tag creation has only the
  immutable owner User-ID bypass, while update/deletion stays under a separate no-bypass ruleset.
  A future dedicated Release App can replace the local principal only when its installation token
  is not available to repository workflows.
