---
name: hra-cloud-efficiency
description: >-
  Qualify, dispatch, monitor, and integrate bounded Codex Cloud repository
  workers for Hraness projects while preserving the caller-selected local
  coordinator, exact pushed Git state, privacy boundaries, and repository
  final gates. Use for Codex Cloud routing, environment readiness, hybrid
  local-and-Cloud validation, or installing the shared Cloud routing baseline.
  Do not use for HRA hosted or Convex operations, local scheduling or cleanup,
  authenticated browsers, 2FA, Mac-native work, releases or deployments,
  agent-phase secrets, private local data, or exact model-and-effort
  preservation.
---

# HRA Cloud efficiency

Use Codex Cloud as a bounded repository-worker lane. Keep the active root and
integration owner local on the caller-selected model. The official CLI creates
a separate Cloud task; it does not convert or move this active task.

## Choose the mode

- **Install or update this machine:** run `bun run scripts/bootstrap.ts
  --apply` from this skill directory, then repeat with `--check`. Start a new
  Codex task after plugin installation or bootstrap so the refreshed skill and
  global guidance are loaded.
- **Qualify a task:** classify every execution and final-proof requirement,
  then run `hra-cloud-route` with the exact repository root, intent, model
  policy, environment profile, owner, and any local-only requirements. Use
  `--online` immediately before dispatch to prove that the remote branch still
  equals the local commit.
- **Create or maintain an environment:** read
  [environment profiles](references/environment-profiles.md). Environment
  creation is a user-visible Codex settings operation, not a private API call.
- **Dispatch, monitor, or integrate:** read
  [Cloud operations](references/cloud-operations.md). Use only documented
  `codex cloud` commands and the installed privacy launch guard.
- **Adopt repository guidance:** use `hra-cloud-adoption --check --root
  ABSOLUTE_REPOSITORY` or the explicit `--apply` form. It edits only this
  plugin's managed block in a root `AGENTS.md`.
- **Diagnose this machine:** run `hra-cloud-efficiency` or
  `hra-cloud-efficiency --json`. The doctor is local and read-only.

Run scripts directly from the installed skill directory when convenience
commands have not been bootstrapped yet.

## Route by hard exclusions first

Keep the task local when its execution needs any of the following:

- an existing signed-in browser profile, extension, passkey, cookie store, or
  interactive OAuth flow;
- npm 2FA, device pairing, Keychain, protected Messages or Contacts, Full Disk
  Access, private SQLite, local archives, or other private local state;
- macOS, Apple Silicon, Xcode, native capture, audio hardware, signing,
  notarization, or a user-visible desktop acceptance step;
- a secret during the agent phase, provider mutation, production publication,
  deployment, release, authoritative production readback, or agent-phase
  network access;
- uncommitted or unpushed inputs, a sibling checkout, or a mutable branch owned
  by another worker;
- exact preservation of the selected model and reasoning effort.

The route command classifies these hard exclusions before inspecting Git. A
valid local decision therefore remains available for a dirty, detached, or
private-only working context and does not require a nominal Cloud source.

Use a hybrid route when implementation and focused Linux validation are
portable but one final proof needs a local authenticated browser, provider,
Mac, signing, or production lane. The Cloud worker must not perform that final
effect.

Cloud is eligible when the task starts from an exact pushed branch, is
Linux-container compatible, has no execution exclusion, is independent of
another worker's mutable files, and benefits from isolated compute, disk, or
background progress. Auth-free headless Chromium is eligible when its browser
and system dependencies are pinned in the environment.

## Preserve model and ownership truth

- A local model selection does not prove the Cloud worker's hosted model or
  reasoning effort. Require the route gate's explicit `cloud-default-ok`
  policy before dispatch. If exact model identity matters, stay local or use a
  compatible connected host.
- Keep the root coordinator and integration owner on the caller-selected
  model. Record each remote lane as `cloud-default`, not as the local model.
- Give every editable Cloud task one unique branch and one owner. Never allow
  concurrent writers on a branch or convergence file.
- Default to one Cloud attempt. Use multiple attempts only for a bounded,
  high-value ambiguous task because every attempt consumes allowance and
  creates additional review work.

## Qualify the exact source

For an editable task, create and push a unique non-default branch before
qualification. For a read-only smoke task, the governed default branch is
allowed.

For Cloud and hybrid candidates, the route gate rejects a dirty or detached
tree, local and tracking-ref drift, hidden index flags, populated Git links,
replacement refs, legacy grafts, semantic Git environment overrides,
unsupported remotes, and editable work on the repository's actual default
branch. Its default check is local. `--online` additionally reads the exact
fully qualified remote branch and requires the same commit.
The report contains safe Git identity and routing facts only. It does not store
the local path, prompt, environment ID, provider output, or account data.

Example:

```sh
umask 077
hra-cloud-route \
  --root /absolute/repository \
  --intent edit \
  --owner feature-owner \
  --profile portable-bun \
  --model-policy cloud-default-ok \
  --environment configured-environment-id \
  --environment-repository hraness/repository \
  --online \
  --json > /absolute/private/dispatch-ready-route.json
```

Add `--needs` for an execution requirement and `--final-needs` for a final
local proof. A valid `local` decision is not an error. Do not omit a known
requirement to obtain a Cloud decision. In particular, `--needs agent-network`
means the worker itself requires runtime network and must stay local;
`--final-needs agent-network` means the portable worker can stay offline while
the local integration owner performs a later network-dependent proof.

## Dispatch and integrate

Build a bounded dispatch packet with the route report's repository slug,
branch, exact commit, intent, owner, profile, scope, acceptance criteria,
focused commands, forbidden operations, and required evidence. State that the
Cloud worker may not merge, release, deploy, mutate a provider, or weaken a
gate.

Use `hra-cloud-exec` to launch the official CLI. It consumes the private
dispatch-ready JSON route report rather than retyped Git identity, resolves its
explicit branch, prepends a mandatory repository, branch, commit, and clean
status preflight, feeds the result through stdin, runs the child in a newly
created private temporary directory, passes only reviewed Codex home, user,
path, locale, terminal, temporary-directory, XDG, and certificate variables,
forwards output and signals, and removes that exact scratch directory. Ambient
API keys, package credentials, and repository-specific environment values do
not enter the CLI process. The environment-repository value is an operator
attestation from visible Codex settings because the CLI cannot inspect that
binding; the worker preflight is the fail-closed backstop. The guard does not
parse provider protocols, store a receipt, or retry. If it is unavailable,
reproduce that privacy boundary explicitly and never run the current alpha
Cloud CLI from a repository directory.

A nonzero result after submission may be ambiguous. Never retry automatically.
Reconcile through `codex cloud list --json` or the visible Cloud UI before any
new task creation.

One owner monitors the task. Do not hold `hra-host-run` or another local
compute lease while waiting. Prefer a reviewed pull request. Never run raw
`codex cloud apply` in an authoritative integration checkout because the
current alpha CLI writes identifier-bearing diagnostics in its working
directory. If an apply is necessary, use the private disposable exact-source
flow in [Cloud operations](references/cloud-operations.md), then integrate the
reviewed Git change through normal ownership. Run the repository's focused and
final gates after convergence. Cloud evidence never replaces a required final
integration, merge, release, deployment, or production-verification receipt.

## Keep adjacent systems separate

- Use `$hra-local-efficiency` for host scheduling, local capability lanes,
  validation receipts, worktree cleanup, CI ref audits, and local throughput
  reports.
- Use repository-owned CI, merge queues, release tools, and deployment tools
  without weakening their gates.
- HRA hosted sync, Convex identity, and remote HRA session authority are
  separate product systems. This skill does not configure or operate them.

Cloud usage shares plan allowance with local Codex usage. Prefer tasks whose
resource or parallelism benefit justifies the hosted-model cost. Recheck the
official Codex documentation when model, pricing, environment, or CLI behavior
affects a decision.
