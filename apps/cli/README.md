# taskctl

`taskctl` is the non-interactive HTTP client for human control-plane administration and agent task work. Human commands use HRA browser pairing; agent commands use an enrolled agent credential and session.

## Human administration

Set `TASKCTL_API_URL` to the task service origin and `TASKCTL_WEB_URL` to the separately hosted browser origin, then authenticate. The web origin is required and pinned before any pairing URL is displayed or opened. After browser approval, the selected organization and workspace are stored for subsequent commands:

```sh
taskctl auth login
taskctl organization list
taskctl organization use ORGANIZATION_ID
taskctl workspace list
taskctl workspace use WORKSPACE_ID
```

Use `taskctl auth login --no-browser` on a headless host. It prints only the browser URL and comparison code to stderr. The locally generated verifier and returned access and refresh tokens stay out of URLs, arguments, output, and profile metadata. Human credentials use immutable generational slots in the operating-system keychain by default; `--secret-store file` selects equivalent owner-only mode-`0600` slots. A token-free, append-only revision journal provides the cross-process compare-and-swap boundary. The profile file is only a display projection: every authorized operation derives its user, organization, and workspace from the winning credential generation.

Version-one human custody is never reinterpreted. A new `taskctl auth login` first copies the exact legacy profile and secret bytes into immutable recovery custody, retires that pointer to durable quarantine without deleting the original Keychain or fallback-file value, and only then commits the new version-two credential.

`organization use` and `workspace use` each rotate the complete access/refresh credential and commit its exact user, organization, and optional workspace as one local compare-and-swap. If the response is lost or local custody cannot commit it, `taskctl` atomically removes the exact involved committed and pending pointers from live admission, retains their Keychain or file bytes plus recovery evidence, and requires pairing again. A stale process cannot retire a newer generation.

The selected workspace is authoritative. Agent administration commands do not accept a workspace override:

```sh
taskctl agent list
taskctl agent show AGENT_ID
taskctl agent credential list AGENT_ID
taskctl agent session list AGENT_ID
taskctl agent credential revoke AGENT_ID CREDENTIAL_ID
taskctl agent disable AGENT_ID
```

Create a new one-time enrollment for an existing agent with an explicit absolute output path:

```sh
taskctl agent enrollment create AGENT_ID \
  --enrollment-out /absolute/private/path/agent.enrollment
```

Enrollment material is generated locally, sent only in the authorized request, and written to a new owner-only mode-`0600` file. It is never printed. If a request outcome is lost, rerun the exact mutation with the existing file and the original `--idempotency-key`; otherwise choose a new path.

Use `--json` for the stable machine-readable output contract. Every mutation generates an idempotency key and returns it with public resource metadata; credential and session listings expose locators and timestamps, never bearer or session secrets.

## Agent authentication and credential custody

Redeem an enrollment token through piped stdin or `TASKCTL_ENROLLMENT_TOKEN`. The CLI generates the long-lived agent bearer credential locally and stores it in the operating-system keychain by default:

```sh
taskctl auth enroll --json < /absolute/private/path/agent.enrollment
```

Use `taskctl auth enroll --secret-store file` only on a host without a usable keychain. This explicit fallback writes only the bearer credential to the configured credential file and enforces an owned regular file with mode `0600`. Session IDs, enrollment recovery state, and agent profile fields are non-secret metadata stored separately; none of those files contains the bearer credential.

An installation created before keychain custody is not migrated silently. Run the following once after reviewing the destination; the legacy file is removed only after the keychain write and replacement metadata both succeed:

```sh
taskctl auth migrate-agent-credential --secret-store keychain --json
```

Passing `--secret-store file` to that migration deliberately retains file-backed custody in the new split format. A failed migration leaves the legacy credential usable for another migration attempt and never prints it.

Containers and CI can inject `TASKCTL_TOKEN` and, when selecting an existing live session, `TASKCTL_SESSION_ID`. Environment injection takes precedence over local custody and is never persisted. `taskctl auth logout` removes keychain or fallback-file authentication and local metadata, but cannot unset parent-process environment variables.

## Work graph and review loop

Agent profiles use the workspace bound to their credential and active session. The core loop is:

```sh
taskctl context --json
taskctl task ready --json
taskctl task claim OPS-7K2M4Q9 --json
taskctl task claim renew OPS-7K2M4Q9 --fence 3 --json
taskctl task submit OPS-7K2M4Q9 --fence 3 --summary "Implemented and tested" \
  --evidence-json '[{"kind":"test","command":"bun test"}]' --json
taskctl review queue --json
taskctl task accept OPS-7K2M4Q9 \
  --submission sub_00000000000000000000000000 --review-revision 4 --json
```

The CLI also exposes strict commands for task show/list/update/cancel/reopen, assignment and defer time, labels, comments, blocking dependencies, parent hierarchy, bounded graph traversal, typed references, events, and workspace repositories. Run `taskctl --help` for exact syntax.

Every mutation accepts `--idempotency-key UUIDV7`; one is generated when omitted and included in JSON output. A claimed-task specification edit accepts `--fence N` and the server rejects a stale owner. Evidence is a closed JSON array with `commit`, `pull_request`, `artifact`, `url`, `test`, or `note` entries; unknown fields fail validation.

Before update, assignment, defer, label, dependency, parent, reference, release, and submit mutations, the CLI reads the authoritative task state. If the authenticated stable agent owns an `in_progress` task whose lease has five minutes or less remaining, it performs exactly one claim renewal with a separate idempotency key and forwards only the renewed revision, fence, generation, and deadline to the requested mutation. A failed or internally inconsistent renewal aborts the requested mutation; a claim held by another agent fails with `CLAIM_NOT_OWNED`. Successful JSON output includes `automaticClaimRenewal` when this preflight renewed the lease. Open tasks still use the explicit revision and optional fence supplied by the caller, while comments and reviewer operations never renew a worker claim.

Task cancellation, reopening, and repository registration use the selected human workspace. The workspace selector comes only from the authoritative human credential generation and cannot be overridden on the command line. Agent task requests never send a tenant selector because the credential and session are already workspace-bound.

## Standalone binaries

The local release builder requires Bun `1.3.14` and compiles four pinned targets:

- `bun-darwin-arm64`
- `bun-darwin-x64`
- `bun-linux-arm64` (glibc)
- `bun-linux-x64-baseline` (glibc baseline)

Build, independently verify, and smoke the current-platform executable with:

```sh
bun run release:build
bun run release:verify
bun run release:smoke
```

The builder refuses to overwrite `release/`. It emits four versioned executables, `install-taskctl.sh`, a strict `taskctl-manifest.json`, and `SHA256SUMS`. Verification rejects symlinks and oversized metadata before reading, requires the exact file set, and checks every declared byte length and SHA-256 digest. This repository builds and verifies the files but does not publish them.

The generated installer accepts one local release directory or one HTTPS GitHub release URL and always requires an explicit absolute destination. Metadata downloads are capped at 64 KiB, artifacts at 512 MiB, and local source sizes are checked with `stat` before any copy:

```sh
./release/install-taskctl.sh \
  --source-dir "$(cd release && pwd -P)" \
  --destination /absolute/physical/bin/taskctl
```

Use `--replace` to replace an existing regular file. The installer is bound to the completed manifest and its four-target catalog, requires the exact six-entry checksum set, and rejects mixed, stale, missing, or extra release metadata. It also rejects relative or symlink-traversing destinations, unsupported operating systems, and Linux musl. It installs one verified executable through a same-directory atomic rename; it does not use `sudo` or unpack an archive.

A GitHub release can be supplied with `--release-url https://github.com/OWNER/REPOSITORY/releases/download/TAG`. For a release that requires authentication, `--github-token-env GITHUB_TOKEN` names the environment variable that holds the token; the token itself is never passed as an argument. It is written only to a mode-`0600` temporary curl configuration, the named environment variable is unset before curl runs, user curl configuration is disabled, and authorization is omitted when following an allowlisted GitHub asset redirect. No release command publishes to GitHub.
