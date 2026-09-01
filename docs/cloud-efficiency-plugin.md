# HRA Cloud efficiency plugin

The repository marketplace distributes `hra-cloud-efficiency`, a Codex plugin for routing bounded repository work to Codex Cloud. It adds hosted compute and disk parallelism without changing HRA hosted sync, Convex authority, the local scheduler, or the public `@hraness/hra` package.

The local root coordinator and integration owner stay on the caller-selected model. A Cloud worker is recorded as `cloud-default`: current Codex Cloud does not carry a desktop task's selected model or reasoning effort into the hosted task. Cloud usage draws from the same Codex plan allowance as local usage, so the route should have a clear isolation, background-progress, or resource benefit.

This workflow does not convert or move the current desktop task. The documented CLI creates a separate Cloud task against a configured repository environment, and the local task continues as coordinator. The human-facing `/cloud` composer action is not a programmatic task-handoff API.

## Usage and cost

As verified on 2026-09-01, eligible Plus, Pro, Business, Enterprise, Edu, Health, Gov, and related workspace plans include or support Codex usage under their plan rules. Local tasks, Cloud tasks, Work, and other eligible agentic features draw from the same allowance and credit pool. Cloud therefore may be covered by an existing subscription until its included limit is reached, but it is not a separate pool of free compute.

Most current plans use token-based Codex credits, while a small set of Enterprise workspaces can remain on a legacy rate card during migration. Actual use depends on the hosted model, input, cached input, output, task size, tools, and attempts. The account's Codex usage page and limit banner are authoritative for included allowance, purchased credits, and reset timing. Do not encode a static per-task dollar estimate in routing policy. See [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) and the current [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card).

## Install or upgrade

Install the Hraness marketplace and both efficiency plugins on each development machine:

```sh
codex plugin marketplace add hraness/hra --ref main --sparse .agents/plugins --sparse plugins
codex plugin add hra-local-efficiency@hraness
codex plugin add hra-cloud-efficiency@hraness
```

Machines that installed the older marketplace snapshot with only `plugins/hra-local-efficiency` must replace it once:

```sh
codex plugin marketplace remove hraness
codex plugin marketplace add hraness/hra --ref main --sparse .agents/plugins --sparse plugins
codex plugin add hra-local-efficiency@hraness
codex plugin add hra-cloud-efficiency@hraness
```

Start a new Codex task after plugin installation so Codex discovers the skill. In that task, invoke `$hra-cloud-efficiency` and apply then check the machine baseline:

```sh
bun run scripts/bootstrap.ts --apply
bun run scripts/bootstrap.ts --check
```

The bootstrap changes only one marker-bounded block in the global Codex `AGENTS.md` and four managed command symlinks in the Bun bin directory. It refuses unrelated files and command links. From a reviewed repository checkout, maintainers can run the equivalent package scripts:

```sh
bun run cloud-efficiency:apply
bun run cloud-efficiency:check
```

For normal upgrades, refresh the snapshot, reinstall the plugin, start a new task, and rerun apply plus check:

```sh
codex plugin marketplace upgrade hraness
codex plugin add hra-cloud-efficiency@hraness
```

## Route work

Keep work local when execution needs an authenticated browser, interactive authentication, 2FA, private local data, macOS, Apple hardware, signing, an agent-phase secret, agent-phase network access, uncommitted input, an exact model and reasoning setting, or a release, deployment, provider, production readback, or production mutation.

Use a hybrid route when implementation and focused Linux checks are portable but a final authenticated, Mac-native, provider, signing, or production proof must remain local. The local integration owner still runs every repository-required final gate.

Use `--needs agent-network` when the worker itself must reach a runtime service; that routes local because pilot agents have internet disabled. Use `--final-needs agent-network` only when the hosted implementation stays offline and a later local integration or proof owns the network access.

Cloud is eligible when the task starts from an exact pushed branch, is Linux-container compatible, has one branch owner, needs no excluded capability, and benefits from isolated compute, disk, or background progress. Auth-free headless Chromium is eligible only when the environment pins the browser and its system dependencies.

Run the route gate locally, then repeat it with `--online` immediately before dispatch:

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

Hard-local requirements are classified before Git inspection, so a valid local decision does not fail merely because its private or uncommitted source is ineligible for Cloud. For Cloud and hybrid candidates, the gate rejects a dirty or detached tree, the repository's actual editable default branch, unknown default-branch identity, mismatched upstream, unpushed commit, hidden index state, Git link, replacement ref, legacy graft, semantic Git environment override, unsupported remote, or changed remote ref. `--environment-repository` is an operator attestation copied from visible Codex settings because the CLI cannot inspect an environment's repository binding. The ordinary report contains only bounded Git and routing identity. It does not contain the prompt, local path, environment ID, account ID, task ID, or provider output.

Adopt the same marker-bounded routing policy in a repository with:

```sh
hra-cloud-adoption --check --root /absolute/repository
hra-cloud-adoption --apply --root /absolute/repository
```

## Create environments

Create environments in [Codex environment settings](https://chatgpt.com/codex/settings/environments). Environment creation is currently a user-visible settings operation; do not automate an undocumented provider endpoint. Limit the GitHub installation to approved pilot repositories, keep agent internet disabled, and configure no secrets unless a reviewed task proves a narrower need. Setup scripts can use network access, while secrets are removed before the agent phase.

The initial public pilot uses:

- `hraness-result-linux` for `hraness/result`, with the `portable-bun` profile;
- `hraness-types-linux` for `hraness/types`, with the `portable-bun` profile;
- `hraness-design-kit-linux-chromium` for `hraness/design-kit`, with the `linux-browser` profile and auth-free Chromium only.

The installed skill's `references/environment-profiles.md` contains the pinned Bun 1.3.14 setup and maintenance scripts. Jungle is not an initial pilot because its present source and branch posture make an isolated public Cloud checkout unsuitable.

Run ten bounded tasks before adding more repositories. Start with read-only checks and focused test or build work, then allow one-owner edit branches. Compare the pilot with the local scheduler's prior seven-day report and record only safe aggregate evidence:

- Cloud terminal outcome, attempt count, elapsed time, focused checks, and whether local repair was required;
- local heavy-command queue time, peak concurrency, and repeated-check candidates;
- Cloud credits from the account usage UI, without copying account or environment identifiers;
- wrong-route, wrong-source, diagnostic-leak, secret-request, and local-final-proof incidents.

Expand only if source preflights and privacy controls have zero failures, at least eight of ten tasks need no material implementation repair, and the local queue or machine-pressure reduction justifies the observed credits. Pause the lane after any source mismatch, unexpected runtime network or secret dependency, diagnostic outside private scratch, or unexplained usage spike. A failed pilot does not weaken local or repository gates.

## Dispatch and integrate

Build a bounded packet containing the repository, branch, exact commit, unique owner, environment profile, scope, acceptance criteria, focused checks, final local-only proofs, forbidden operations, and required evidence. Do not include local paths, credentials, cookies, private corpora, or unrelated conversation history.

Launch one attempt by default:

```sh
hra-cloud-exec \
  --environment ENVIRONMENT_ID \
  --attempts 1 \
  --route-file /absolute/private/dispatch-ready-route.json \
  --prompt-file /absolute/private/task-packet
```

The route file and prompt must be current-user-owned private regular files. The launcher takes the branch, repository, and exact commit from the dispatch-ready route instead of retyped arguments, then prepends a mandatory source and clean-status preflight plus the full worker restrictions. The official alpha CLI currently creates a diagnostic `error.log` in its working directory that can contain account, environment, task, and backend identifiers. The guard therefore runs it in a fresh private scratch directory, sends the guarded prompt over stdin, passes only reviewed Codex home, user, path, locale, terminal, temporary-directory, XDG, and certificate variables, forwards output and signals, and removes that exact directory. Ambient API keys and package or repository credentials are excluded. Never run the current Cloud CLI from a repository directory. A failed submission can be ambiguous, so the guard never retries automatically.

One owner reconciles and monitors a task through the visible Cloud UI or documented `codex cloud list --json`, `status`, and `diff` commands, also from private scratch. Do not hold a local host-scheduler lease while waiting. Prefer a reviewed pull request. Never run raw `codex cloud apply` in an authoritative checkout; if it is required, use a mode-`0700` disposable exact-source clone, prove root `error.log` absent, privately exclude only anchored `/error.log`, inspect the diagnostic and ignored files separately, convert the result into a normal owned change, and dispose the entire private parent. Run focused checks plus the repository aggregate gate after convergence. Cloud completion never authorizes merge, release, deployment, production mutation, or skipped validation.

Run the deterministic plugin suite before handoff:

```sh
bun run test:cloud-efficiency-plugin
```

Product behavior and plan facts in this document were verified on 2026-09-01 against the official [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [Codex Cloud environment](https://learn.chatgpt.com/docs/environments/cloud-environment), and [workspace model availability](https://learn.chatgpt.com/docs/enterprise/workspace-model-availability) documentation.
