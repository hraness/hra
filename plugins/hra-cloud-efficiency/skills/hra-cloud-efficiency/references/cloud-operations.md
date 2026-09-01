# Codex Cloud operations

Read this reference only when a task has passed the route gate and needs to be dispatched, monitored, or integrated.

## Dispatch packet

Include:

- repository slug, exact source branch, and governed commit;
- `read-only` or `edit` intent and the unique owner;
- environment profile and `cloud-default` model label;
- bounded file or subsystem scope;
- acceptance criteria and focused commands;
- local-only final proofs;
- forbidden merge, release, deployment, provider, credential, and gate changes;
- required final Git status and command evidence.

Do not include local absolute paths, credentials, cookies, private corpora, or unrelated conversation history.

## Official CLI lifecycle

Create one attempt unless the task explicitly justifies more:

```sh
umask 077
hra-cloud-route ... --online --json > /absolute/private/dispatch-ready-route.json
hra-cloud-exec --environment ENVIRONMENT_ID --attempts 1 --route-file /absolute/private/dispatch-ready-route.json --prompt-file /absolute/private/task-packet
```

The route file and task packet must be current-user-owned, single-link regular files with no group or world permissions. The guard accepts only an online, dispatch-ready, `cloud-default-ok` Cloud or hybrid report. It calls `codex cloud exec` with no prompt argument, takes the explicit branch and worker restrictions from that report, prepends its exact-source preflight, feeds the bounded result through stdin, and runs in a fresh private scratch directory with an allowlisted process environment. Ambient API keys, package credentials, and repository-specific environment values are not inherited. The environment ID remains a separate private launch argument. Its repository pairing is an operator attestation from the visible settings page; the mandatory worker-side repository, branch, commit, and clean-status preflight stops a wrong environment before task work.

Inspect the resulting task with documented commands:

```sh
codex cloud list --env ENVIRONMENT_ID --json
codex cloud status TASK_ID
codex cloud diff --attempt 1 TASK_ID
```

Run status and diff from a private temporary directory because the current alpha CLI writes diagnostics in its working directory. Prefer a reviewed pull request for integration. Never run raw `codex cloud apply` in the authoritative checkout.

When apply is the only documented integration path, create a fresh mode-`0700` private parent and a disposable clone at the exact governed source. Prove that root `error.log` is absent, add only the anchored pattern `/error.log` to that clone's private `.git/info/exclude`, set a restrictive umask, and run `codex cloud apply --attempt 1 TASK_ID` there. Inspect the root diagnostic separately, and verify with ignored files shown that the only other worktree changes are the reviewed task changes. Convert the reviewed diff into a normal owned commit or pull request, then dispose the complete private parent. Do not copy the diagnostic, prompt, provider output, or private route file into the authoritative repository. If the CLI creates a different diagnostic path or the source identity changes, stop rather than deleting an unknown file.

## Ambiguity and completion

The CLI validates local argument failures with exit 2. A provider or network exit 1 around task creation may follow an accepted remote effect. Do not retry automatically unless pre-acceptance failure is proved. Reconcile through `codex cloud list --json` or the visible task UI.

Record the task ID, environment label, source commit, branch owner, attempt count, terminal state, focused commands, and integration outcome. Do not record the prompt, environment ID, account ID, raw provider diagnostics, or hidden model reasoning in repository telemetry.

Cloud completion is focused evidence. The local integrator still owns convergence, the repository-required aggregate gate, pull request, merge queue, release, deployment, and production readback.

Official references:

- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Codex Cloud](https://learn.chatgpt.com/docs/cloud)
- [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment)
