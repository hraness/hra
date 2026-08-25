# Beta release

The `v0.1.0` release has two explicit irreversible steps. Pushing the protected `v0.1.0` tag is the version-identity commit point because repository rules provide no supported update or deletion rollback. Publishing the accepted draft is the publication commit point. GitHub then protects the associated tag and five uploaded assets under immutable releases, while the release title and body remain editable. HRA therefore treats the checksummed `RELEASE_NOTES.md` asset as the durable reviewed notes authority and requires the body to remain an exact presentation of those bytes. GitHub Actions verifies that the tag selects the accepted commit, protected `main` still contains that commit, and the read-visible immutable-tag rules remain active. It builds and accepts the tarball, generates both SPDX records, creates or resumes one draft release, replaces its five assets with the accepted bytes, reads every asset back, and stops. Normal forward-only `main` development may continue after the tag. The built-in Actions token never publishes the draft because it cannot read the repository's immutable-release setting or the ruleset's protected bypass details.

The tag workflow and local publisher share the fixed `hra-release-publication-v0.1.0` GitHub Actions concurrency group. Its `queue: max` policy retains pending runs instead of replacing one pending operator with another, subject to GitHub's limit of 100 queued runs. Every sanctioned draft mutation happens in the tag workflow while it owns that group. The local publisher dispatches a unique `workflow_dispatch` lease run on `v0.1.0` and waits at most 45 minutes for that exact run to become `in_progress` before entering its publication critical section. GitHub keeps staging reruns and other local publishers queued behind the same server-side lease. A lease job itself has a six-hour timeout. Do not edit the draft manually or through another API client.

Before dispatch, the publisher proves the recovery directory is canonical, owned by the invoking user, and mode `0700` under the operating-system account's `~/.local/state/hra/release-publication/`. It deliberately ignores mutable `HOME` and `XDG_STATE_HOME` values for this authority path. Every ancestor must reject unsafe write authority and, on macOS, unsafe inherited or explicit ACL entries. The publisher creates an exclusive mode-`0600` temporary descriptor, writes and reads back the bounded holder-first document through that descriptor, syncs the file, atomically renames it, proves the destination is the same owned single-link regular file, and syncs the containing directory. Only that completed sequence permits dispatch. Every later `bound`, `active`, `cancelled`, or `published` transition uses the same durable sequence and fails closed if persistence cannot be proved. The publisher prints the exact receipt path and holder to stderr. Treat the receipt as operator recovery evidence. Every acquisition refusal caused by an unproved lost dispatch includes that path. A queued run can outlive the six-hour execution timeout because that timeout begins only after GitHub starts the job.

Create, verify, tag, and publish only from a clean detached worktree at the accepted commit. `HEAD` and `origin/main` must both resolve to that exact commit, `git symbolic-ref -q HEAD` must fail, and `git status --porcelain=v1 --untracked-files=all` must be empty. Use an authenticated GitHub CLI session that can read repository administration settings. Do not copy a broad personal token into Actions.

## Local subprocess recovery

Local release work records process-group custody under the operating-system account's fixed `~/.local/state/hra/process-recovery/` directory. Mutable `HOME` and XDG values cannot redirect it. The directory and every ancestor are checked for canonical identity, ownership, modes, and macOS ACL authority. A mode-`0600` lock serializes startup recovery with launch. HRA durably writes a `pending` intent before spawn, keeps the child behind a private gate, atomically promotes the intent to an `active` journal containing the process-group ID, and releases the child only after that active journal is synced and read back. A pending journal proves the child never crossed the gate. An active journal is removed only after the operating system proves that its exact process group no longer exists. An incomplete promotion remains a hard stop.

That local boundary is deliberately narrow. It proves custody only of the recorded process group. A descendant can create a new session or double-fork outside that group, so local custody is not a sandbox and never authorizes a provider or remote-Git action.

Provider and remote-Git actions are classified as `authority` work. They require the supported Linux native authority backend, which provides descendant-lifetime custody. It verifies the pinned helper, executes a sealed in-memory copy, journals the host, boot, PID-namespace, mount-namespace, outer-process, and namespace-init identities before `GO`, and retains the private PID-namespace reaper until descendants are gone. The helper rejects a bind-mounted alias of any recovery-directory ancestor, conceals custody before entering the target working directory, and enforces the same authenticated monotonic deadline independently in both the outer supervisor and namespace PID 1. An unavailable, malformed, expired, or unproven backend refuses before the target executes or preserves recovery evidence. macOS and other unsupported platforms refuse as unsupported. HRA never falls back to local process-group custody for authority work.

For local work, a timeout, output-limit, interruption, or shutdown failure that cannot prove the whole recorded group absent returns machine-readable `status: "recovery_required"` with code `process_cleanup_unproven`, exact phase and process identities, and every protected recovery path. A later invocation first scans the same journals. It refuses with `process_recovery_journal_blocked` while any recorded group may still exist and clears only state whose absence is proved. Both terminal states exit `75`. Their sorted `recoveryPaths` include every known process journal, candidate or lease receipt, durable intent, and child-reachable temporary root that must be preserved; the publication renderer also names recognized receipt and temporary paths explicitly. Do not delete or edit a journal, retry the associated operation, discard a candidate or evidence file, or start another local operator while local custody is uncertain. Preserve every reported path. After the group is proved absent, rerun the checked command so its startup recovery and durable state machine can reconcile its local state.

Authority custody, once accepted, will still not be a sandbox and cannot prove that a remote effect did not occur. Durable receipts, provider idempotency, and exact reconciliation remain mandatory after every ambiguous provider or remote-Git outcome.

## Stage the draft

Complete staged hosted bootstrap and live acceptance while invitations remain disabled. Merge the `release-ready` public-content change, then record that exact protected merge as `N_COMMIT`. Guardedly deploy the Convex functions from `N_COMMIT`; rerun the full live gate and repository gate from a clean checkout of that commit. Build and accept the exact Vercel N deployment from `N_COMMIT`, assign it to `try-hra.vercel.app`, and accept the full public staging surface. Run the checked forward and reverse domain rehearsal against exact Q and N. Perform the final forward move and independently re-prove canonical traffic, project ownership, both fixed fallback aliases, both markers, and the rollback source.

Seal the pre-tag candidate before creating `v0.1.0`. The bootstrap deploy may come from an earlier clean commit: its source is bound by its runtime and live receipts, and the candidate deploy must name the bootstrap deploy digest and start from that exact runtime. The candidate deploy, both later cutover directions, final authority, Vercel N deployment, rendered release-ready surface, and all three successful CI jobs must bind `N_COMMIT`. The CI jobs must be `Check (macos-15)`, `Check (ubuntu-24.04)`, and `Required` from one exact run ID, attempt, and head.

Create the receipt from the seven protected evidence files. Every evidence directory must be canonical, invoking-user-owned, and mode `0700`; every evidence file is bounded, single-link, no-follow, and mode `0600`. The default output is the operating-system account's `~/.local/state/hra/release-candidates/v0.1.0-<N_COMMIT>.json`; mutable `HOME` and `XDG_STATE_HOME` values are ignored. An explicit output must be an absolute path under an equivalent protected directory.

```sh
bun run release:candidate -- create \
  --source-commit <N_COMMIT> \
  --bootstrap-deploy-evidence /protected/release/bootstrap-deploy.json \
  --bootstrap-live-evidence /protected/release/bootstrap-live.json \
  --candidate-deploy-evidence /protected/release/candidate-deploy.json \
  --candidate-live-evidence /protected/release/candidate-live.json \
  --forward-cutover-evidence /protected/release/forward.json \
  --reverse-cutover-evidence /protected/release/reverse.json \
  --final-forward-cutover-evidence /protected/release/final-forward.json \
  --deployment-id <exact-N-deployment-id> \
  --deployment-url <exact-N-bare-automatic-hostname> \
  --fallback-deployment-id <exact-Q-deployment-id> \
  --fallback-deployment-url <exact-Q-bare-automatic-hostname> \
  --fallback-source-commit <exact-Q-commit> \
  --fallback-version <exact-Q-version> \
  --gh-cli /opt/homebrew/bin/gh \
  --vercel-cli /absolute/path/to/vercel \
  --output /protected/release/v0.1.0-<N_COMMIT>.json

bun run release:candidate -- verify \
  --candidate-receipt /protected/release/v0.1.0-<N_COMMIT>.json \
  --gh-cli /opt/homebrew/bin/gh \
  --vercel-cli /absolute/path/to/vercel
```

`create` reads provider authority and writes only the protected receipt. `verify` is read-only. Neither command deploys, moves a domain, creates a tag, stages a release, or dispatches a workflow. An existing exact receipt replays only if every authority remains exact. A changed ref, runtime, CI run, surface, deploy, cutover, tag, or release state is a refusal.

The tag action is the only release-candidate command authorized to mutate Git. It revalidates every volatile read, creates one exact annotated local tag, revalidates again, and pushes only that tag. Both irreversible acknowledgements and the protected receipt are mandatory:

```sh
bun run release:candidate -- tag \
  --candidate-receipt /protected/release/v0.1.0-<N_COMMIT>.json \
  --gh-cli /opt/homebrew/bin/gh \
  --vercel-cli /absolute/path/to/vercel \
  --execute \
  --acknowledge-immutable-tag
```

The annotation carries the receipt's exact SHA-256. The Release workflow rejects a lightweight or differently annotated tag, preserves the candidate digest as a non-release artifact, and binds its publication lease input to that same digest. It still uploads exactly five release assets. The Release workflow must finish with `Stage verified release draft` successful. Later `main` commits are allowed only through the protected forward history and do not change the immutable release selection.

Record the exact workflow run ID and attempt from GitHub. Do not select “latest.” The publication command checks repository ID `1343008607`, path `hraness/hra`, workflow name and path, tag push, run ID and attempt, head commit, and successful conclusion. Artifacts are named `hra-release-v0.1.0-run-<run-id>-attempt-<run-attempt>` at upload and stage download. The artifact API may retain distinct prior attempts for the same run; the local publisher accepts and downloads exactly one unexpired artifact whose encoded run ID and attempt match the operator's arguments.

## Publish

From a clean checkout at the exact tagged `N_COMMIT`, run:

```sh
bun run release:publish -- publish \
  --candidate-receipt /protected/release/v0.1.0-<N_COMMIT>.json \
  --tag v0.1.0 \
  --run-id <exact-run-id> \
  --run-attempt <exact-run-attempt> \
  --expected-commit <N_COMMIT> \
  --deployment-id <exact-N-deployment-id> \
  --deployment-url <exact-N-bare-automatic-hostname> \
  --fallback-deployment-id <exact-Q-deployment-id> \
  --fallback-deployment-url <exact-Q-bare-automatic-hostname> \
  --fallback-version <exact-Q-version> \
  --gh-cli /opt/homebrew/bin/gh \
  --vercel-cli /absolute/path/to/vercel \
  --acknowledge-immutable-publication
```

Before publication, the operator downloads the exact one-day Actions artifact; validates its exact file set, checksums, artifact-identity SPDX record, Ubuntu 24.04 x64 runtime SPDX inventory, and package tree; compares every draft asset plus the exact current title, body, and flags; and requires the REST release record to be `draft: true` and `immutable: false`. It also creates a deterministic lifecycle-disabled pack from the clean tagged source and requires exact tarball and reviewed-notes equality. The draft body must exactly equal the checksummed `RELEASE_NOTES.md` asset. The local publisher statically inspects the candidate archive but never imports it, invokes its binary, or runs package lifecycle scripts. Temporary `HOME` and XDG directories plus a scrubbed subprocess environment reduce accidental credential exposure; they are hygiene, not filesystem, network, or keychain containment. Executable package acceptance belongs to the credential-free GitHub Actions jobs. The operator re-resolves the fully qualified tag, proves protected `main` contains the tag commit, reads immutable-release enforcement, and requires the local admin session to see the exact immutable-tag ruleset with no bypass actors and no current-user bypass.

The publisher then dispatches the receipt's 32-hex-character lease holder to the same Release workflow at the exact protected tag with `return_run_details=true`. A successful current API response must contain `workflow_run_id`, `run_url`, and `html_url`; the numeric ID and both URLs must identify the exact `hraness/hra` run. If the dispatch response is lost, empty, or malformed, the publisher terminally paginates dispatch runs for that holder title in pages of 100. It stops only on a short final page, with a hard ceiling of 100 pages. Reaching that 10,000-run ceiling without disproving truncation fails closed. The scan filters unrelated list entries before strict parsing, binds the one exact run ID, attempt, workflow path, repository, tag head, and commit, and updates the receipt. Transient list and run-read failures are retried only inside the 45-minute acquisition window. The publisher may report `publication_lease_unavailable` for an apparently lost dispatch only after a final complete scan proves that no matching run exists. A duplicate or partially malformed holder match is never guessed away. At the deadline, every identified duplicate is cancelled and each exact terminal identity is proved; an unidentified matching candidate, incomplete final scan, or unproved cleanup reports `publication_lease_cleanup_failed` with the receipt path. The lease job remains active while the release is the accepted mutable draft. After the exact release becomes public and immutable, it continues into executable public acceptance.

Inside that lease, the publisher repeats tag, ancestry, ruleset, immutable-setting, and hosted-authority checks. The hosted read proves both fixed projects, disabled automatic-domain assignment, exact N and Q deployment records, canonical and staging alias tuples, new-project ownership, Q fallback, and uncached generation markers at their bound commits and versions. It downloads and compares the five draft assets again, rechecks that the exact lease run is still `in_progress` with at least one hour left before its six-hour timeout, and makes the exact current title, body, flags, and asset-ID tuple its final release-state reads. It revalidates the protected candidate receipt immediately before acquiring the lease and again immediately before PATCH; the digest must still equal the tag annotation, Actions artifact, and durable publication receipt. It then reasserts the exact active lease immediately before PATCH. A public marker is product evidence; the authenticated alias and deployment tuples remain traffic authority.

GitHub documents conditional requests for unsafe methods as unsupported unless an endpoint explicitly says otherwise, and the Update a release endpoint documents no write precondition. The publisher therefore does not send a cosmetic `If-Match` header. The shared Actions lease is the cross-operator exclusion mechanism. See [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) and [Update a release](https://docs.github.com/en/rest/releases/releases#update-a-release).

Undrafting is the publication commit point; the protected tag push is the earlier version-identity commit point. The operator PATCHes the numeric release ID whose current title, body, flags, and five assets it just accepted; it never resolves the tag again for the mutation. The PATCH carries the exact accepted tag, title, notes, prerelease flag, and `make_latest: false` along with `draft: false`, and its response must identify the same release as public and immutable. The publisher waits for the exact lease run to observe that state and finish successfully. Completion reads retry transient command, transport, JSON, and run-envelope failures, while a successfully parsed identity change remains terminal. The default wait is bounded by the workflow's six-hour timeout and the exact run's remaining execution budget, rather than a fixed three-minute cleanup window. In that fresh Ubuntu job, the exact protected-tag preflight must return its fixed success token before package installation. It requires pinned Bun, selects the explicit package and command directories below the temporary `BUN_INSTALL`, creates missing components with owner-only modes, and rejects unsafe ancestry. Pinned Bun then installs the exact public HTTPS tarball with `--backend=copyfile --ignore-scripts`, statically verifies HRA's zero-lifecycle manifest, and invokes the reviewed normalizer from the exact pinned package path. The install operation runs no package lifecycle and leaves `trustedDependencies` unchanged. The normalizer quarantines the command before verifying the exact package, version, CLI digest, protected parent directories, ownership, inode, link topology, and command path. It atomically publishes a fresh mode-`0755` executable only after those checks and disables the current CLI and command link on any later failure. The job then checks the production package tree, version, and offline doctor, downloads the public runtime SPDX record, and requires its package inventory to equal the installed inventory. The local operator repeats complete hosted authority, exact current title, body, and flags, all five immutable asset reads, anonymous tarball digest verification, and final hosted authority. It requires the editable body to remain an exact presentation of the immutable checksummed notes asset. It does not execute public candidate code locally.

Success prints one bounded JSON value with status `published`. A refusal before PATCH cancels every exact run associated with its holder and reasserts holder, run ID, attempt, workflow path, repository, tag head, and commit on every read. Cancellation is proved only by `status: completed` with `conclusion: cancelled`. If a run instead completed successfully, the publisher reads the exact numeric release again and requires the accepted public state: the current title, body, and flags, plus the immutable asset-ID tuple. A matching release is an acceptance-only `publication_lease_completed` result; a mismatch is `publication_unknown`. Any other terminal conclusion, unidentified matching holder, or inability to prove cleanup reports `publication_lease_cleanup_failed` with available run evidence and does not claim a safe handoff. A process crash leaves the durable receipt and may leave a run queued or holding the concurrency group. Run the checked receipt recovery action below before retrying; a queued run does not expire merely because the six-hour execution timeout has not started.

An ambiguous undraft reports `publication_unknown` with `leaseRunId` and deliberately does not cancel the lease. Inspect that numeric workflow run and the exact release before doing anything else. If the release is public and immutable, the lease exits on its own and recovery is acceptance-only. If the release is still the exact draft and the PATCH did not land, cancel that one lease run and wait for its terminal state before rerunning publication. Never cancel an active lease merely because its owner stopped producing terminal output.

## Publication receipt recovery

From a clean checkout at the receipt's exact tagged commit, reconcile a publisher crash or lost dispatch response with the receipt path printed by the failed command:

```sh
bun run release:publish -- recover \
  --tag v0.1.0 \
  --expected-commit <N_COMMIT> \
  --receipt /absolute/path/to/release-publication/v0.1.0-<holder>.json \
  --gh-cli /opt/homebrew/bin/gh \
  --acknowledge-cancel-prepublication-leases
```

The action opens only the exact canonical recovery directory and an invoking-user-owned, single-link, mode-`0600` regular receipt without following links. It reads the bounded receipt through that descriptor and rechecks the directory, path, inode, file name, schema, repository, workflow, tag, commit, holder, and complete run identity. It then proves the live repository, workflow, and protected tag commit, terminally paginates every holder candidate through a short final page, and refuses duplicate entries, partial identities, malformed matching runs, or unproved truncation.

If the release is already public, recovery accepts only the exact current prerelease title, body, and flags; the protected tag; the five immutable public assets; checksum and SPDX contracts; authenticated asset IDs; and an unchanged second readback. The checksummed notes asset must equal the reviewed tagged-source notes, and the editable body must exactly present that asset. Recovery then returns `published`; publication must not be retried. If the release remains the exact reviewed mutable draft, recovery cancels every queued or active matching run, reads every exact run ID and attempt back as terminal `cancelled`, repeats the complete holder scan, and reasserts the unchanged draft release and asset-ID tuple. Only then does it return `retry_permitted`. A matching successful run triggers immutable-state acceptance. Any other terminal conclusion, changing release state, new run that cannot be reconciled within the bounded passes, or incomplete identity returns a refusal containing the receipt path. Never infer a missing run or copy run fields between receipts.

## Acceptance recovery

If publication succeeded but a later readback or public-route check failed, never delete, rewrite, or replace the immutable release. From a clean checkout of `N_COMMIT`, retry only acceptance:

```sh
bun run release:publish -- accept \
  --candidate-receipt /protected/release/v0.1.0-<N_COMMIT>.json \
  --tag v0.1.0 \
  --run-id <exact-run-id> \
  --run-attempt <exact-run-attempt> \
  --expected-commit <N_COMMIT> \
  --deployment-id <exact-N-deployment-id> \
  --deployment-url <exact-N-bare-automatic-hostname> \
  --fallback-deployment-id <exact-Q-deployment-id> \
  --fallback-deployment-url <exact-Q-bare-automatic-hostname> \
  --fallback-version <exact-Q-version> \
  --gh-cli /opt/homebrew/bin/gh \
  --vercel-cli /absolute/path/to/vercel
```

The Actions artifact is retained for one day and is mandatory before the publication commit point. If it expires while the release is still a draft, rerun the exact tag workflow, record the new exact run attempt, and repeat the checks. After immutable publication, `accept` does not trust the release tarball as its own source authority: it reproduces the lifecycle-disabled pack and reviewed notes from the exact clean tag, requires exact equality, validates the five durable public assets through their checksum and SPDX contracts, requires the editable body to present the immutable notes asset exactly, and dispatches a new exact lease run for executable public-URL and runtime-inventory acceptance. This post-expiry path validates the immutable public bundle semantically; prepublication byte identity to the original Actions artifact was established by the publishing run and cannot be reconstructed after that artifact expires.

The staging workflow safely resumes one exact draft and replaces the five expected assets with accepted bytes. If the draft has a wrong title, body, flag, or unexpected extra asset, first read its numeric ID, tag, draft state, and asset list through the GitHub API. Delete only that confirmed unpublished `v0.1.0` draft, leave the tag untouched, rerun the tag workflow, and use its new exact run attempt. Never use this cleanup path after publication.
