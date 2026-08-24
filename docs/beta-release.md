# Beta release

The `v0.1.0` release has two explicit irreversible steps. Pushing the protected `v0.1.0` tag is the version-identity commit point because repository rules provide no supported update or deletion rollback. Undrafting the accepted release then makes its metadata and assets immutable. GitHub Actions verifies that the tag selects the accepted commit, protected `main` still contains that commit, and the read-visible immutable-tag rules remain active. It builds and accepts the tarball, generates both SPDX records, creates or resumes one draft release, replaces its four assets with the accepted bytes, reads every asset back, and stops. Normal forward-only `main` development may continue after the tag. The built-in Actions token never publishes the draft because it cannot read the repository's immutable-release setting or the ruleset's protected bypass details.

The tag workflow and local publisher share the fixed `hra-release-publication-v0.1.0` GitHub Actions concurrency group. Its `queue: max` policy retains pending runs instead of replacing one pending operator with another, subject to GitHub's limit of 100 queued runs. Every sanctioned draft mutation happens in the tag workflow while it owns that group. The local publisher dispatches a unique `workflow_dispatch` lease run on `v0.1.0` and waits at most 45 minutes for that exact run to become `in_progress` before entering its publication critical section. GitHub keeps staging reruns and other local publishers queued behind the same server-side lease. A lease job itself has a six-hour timeout. Do not edit the draft manually or through another API client.

Before dispatch, the publisher proves the recovery directory is canonical, owned by the invoking user, and mode `0700` under `$XDG_STATE_HOME/hra/release-publication/`, or `$HOME/.local/state/hra/release-publication/` when `XDG_STATE_HOME` is unset. It creates an exclusive mode-`0600` temporary descriptor, writes and reads back the bounded holder-first document through that descriptor, syncs the file, atomically renames it, proves the destination is the same owned single-link regular file, and syncs the containing directory. Only that completed sequence permits dispatch. Every later `bound`, `active`, `cancelled`, or `published` transition uses the same durable sequence and fails closed if persistence cannot be proved. The publisher prints the exact receipt path and holder to stderr. Treat the receipt as operator recovery evidence. Every acquisition refusal caused by an unproved lost dispatch includes that path. A queued run can outlive the six-hour execution timeout because that timeout begins only after GitHub starts the job.

Publish only from a clean checkout of the accepted commit with an authenticated GitHub CLI session that can read repository administration settings. Do not copy a broad personal token into Actions.

## Stage the draft

Complete staged hosted bootstrap and live acceptance while invitations remain disabled. Merge the `release-ready` public-content change, then record that exact protected merge as `N_COMMIT`. Guardedly deploy the Convex functions from `N_COMMIT`; rerun the full live gate and repository gate from a clean checkout of that commit. Build and accept the exact Vercel N deployment from `N_COMMIT`, assign it to `try-hra.vercel.app`, and accept the full public staging surface. Run the checked forward and reverse domain rehearsal against exact Q and N. Perform the final forward move and independently re-prove canonical traffic, project ownership, both fixed fallback aliases, both markers, and the rollback source.

Only then create `v0.1.0` at `N_COMMIT` and push that one tag. The Release workflow must finish with `Stage verified release draft` successful. Later `main` commits are allowed only through the protected forward history and do not change the immutable release selection.

Record the exact workflow run ID and attempt from GitHub. Do not select “latest.” The publication command checks repository ID `1343008607`, path `hraness/hra`, workflow name and path, tag push, run ID and attempt, head commit, and successful conclusion. Artifacts are named `hra-release-v0.1.0-run-<run-id>-attempt-<run-attempt>` at upload and stage download. The artifact API may retain distinct prior attempts for the same run; the local publisher accepts and downloads exactly one unexpired artifact whose encoded run ID and attempt match the operator's arguments.

## Publish

From a clean checkout at the exact tagged `N_COMMIT`, run:

```sh
bun run release:publish -- publish \
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

Before publication, the operator downloads the exact one-day Actions artifact; validates its exact file set, checksums, artifact-identity SPDX record, Ubuntu 24.04 x64 runtime SPDX inventory, and package tree; compares every draft asset and all release metadata; and requires the REST release record to be `draft: true` and `immutable: false`. It also creates a deterministic lifecycle-disabled pack from the clean tagged source and requires exact tarball and reviewed-notes equality. The local publisher statically inspects the candidate archive but never imports it, invokes its binary, or runs package lifecycle scripts. Temporary `HOME` and XDG directories plus a scrubbed subprocess environment reduce accidental credential exposure; they are hygiene, not filesystem, network, or keychain containment. Executable package acceptance belongs to the credential-free GitHub Actions jobs. The operator re-resolves the fully qualified tag, proves protected `main` contains the tag commit, reads immutable-release enforcement, and requires the local admin session to see the exact immutable-tag ruleset with no bypass actors and no current-user bypass.

The publisher then dispatches the receipt's 32-hex-character lease holder to the same Release workflow at the exact protected tag with `return_run_details=true`. A successful current API response must contain `workflow_run_id`, `run_url`, and `html_url`; the numeric ID and both URLs must identify the exact `hraness/hra` run. If the dispatch response is lost, empty, or malformed, the publisher terminally paginates dispatch runs for that holder title in pages of 100. It stops only on a short final page, with a hard ceiling of 100 pages. Reaching that 10,000-run ceiling without disproving truncation fails closed. The scan filters unrelated list entries before strict parsing, binds the one exact run ID, attempt, workflow path, repository, tag head, and commit, and updates the receipt. Transient list and run-read failures are retried only inside the 45-minute acquisition window. The publisher may report `publication_lease_unavailable` for an apparently lost dispatch only after a final complete scan proves that no matching run exists. A duplicate or partially malformed holder match is never guessed away. At the deadline, every identified duplicate is cancelled and each exact terminal identity is proved; an unidentified matching candidate, incomplete final scan, or unproved cleanup reports `publication_lease_cleanup_failed` with the receipt path. The lease job remains active while the release is the accepted mutable draft. After the exact release becomes public and immutable, it continues into executable public acceptance.

Inside that lease, the publisher repeats tag, ancestry, ruleset, immutable-setting, and hosted-authority checks. The hosted read proves both fixed projects, disabled automatic-domain assignment, exact N and Q deployment records, canonical and staging alias tuples, new-project ownership, Q fallback, and uncached generation markers at their bound commits and versions. It downloads and compares the four draft assets again, rechecks that the exact lease run is still `in_progress` with at least one hour left before its six-hour timeout, and makes the exact release metadata and asset-ID tuple its final release-state reads. It then reasserts the exact active lease immediately before PATCH. A public marker is product evidence; the authenticated alias and deployment tuples remain traffic authority.

GitHub documents conditional requests for unsafe methods as unsupported unless an endpoint explicitly says otherwise, and the Update a release endpoint documents no write precondition. The publisher therefore does not send a cosmetic `If-Match` header. The shared Actions lease is the cross-operator exclusion mechanism. See [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) and [Update a release](https://docs.github.com/en/rest/releases/releases#update-a-release).

Undrafting is the publication commit point; the protected tag push is the earlier version-identity commit point. The operator PATCHes the numeric release ID whose metadata and assets it just accepted; it never resolves the tag again for the mutation. The PATCH carries the exact accepted tag, title, notes, prerelease flag, and `make_latest: false` along with `draft: false`, and its response must identify the same release as public and immutable. The publisher waits for the exact lease run to observe that state and finish successfully. Completion reads retry transient command, transport, JSON, and run-envelope failures, while a successfully parsed identity change remains terminal. The default wait is bounded by the workflow's six-hour timeout and the exact run's remaining execution budget, rather than a fixed three-minute cleanup window. In that fresh Ubuntu job, pinned Bun installs the exact public HTTPS tarball with lifecycle scripts disabled under temporary `HOME` and XDG state, checks the production package tree, version, and offline doctor, downloads the public runtime SPDX record, and requires its package inventory to equal the installed inventory. The local operator then repeats complete hosted authority, exact immutable release metadata and asset reads, anonymous tarball digest verification, and final hosted authority. It does not execute public candidate code locally.

Success prints one bounded JSON value with status `published`. A refusal before PATCH cancels every exact run associated with its holder and reasserts holder, run ID, attempt, workflow path, repository, tag head, and commit on every read. Cancellation is proved only by `status: completed` with `conclusion: cancelled`. If a run instead completed successfully, the publisher reads the exact numeric release again and requires the accepted public immutable metadata and asset-ID tuple. A matching release is an acceptance-only `publication_lease_completed` result; a mismatch is `publication_unknown`. Any other terminal conclusion, unidentified matching holder, or inability to prove cleanup reports `publication_lease_cleanup_failed` with available run evidence and does not claim a safe handoff. A process crash leaves the durable receipt and may leave a run queued or holding the concurrency group. Run the checked receipt recovery action below before retrying; a queued run does not expire merely because the six-hour execution timeout has not started.

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

If the release is already public, recovery accepts only the exact immutable prerelease metadata, reviewed notes, deterministic tagged archive, four public assets, checksum and SPDX contracts, authenticated asset IDs, and unchanged second readback. It returns `published`; publication must not be retried. If the release remains the exact reviewed mutable draft, recovery cancels every queued or active matching run, reads every exact run ID and attempt back as terminal `cancelled`, repeats the complete holder scan, and reasserts the unchanged draft release and asset-ID tuple. Only then does it return `retry_permitted`. A matching successful run triggers immutable-state acceptance. Any other terminal conclusion, changing release state, new run that cannot be reconciled within the bounded passes, or incomplete identity returns a refusal containing the receipt path. Never infer a missing run or copy run fields between receipts.

## Acceptance recovery

If publication succeeded but a later readback or public-route check failed, never delete, rewrite, or replace the immutable release. From a clean checkout of `N_COMMIT`, retry only acceptance:

```sh
bun run release:publish -- accept \
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

The Actions artifact is retained for one day and is mandatory before the publication commit point. If it expires while the release is still a draft, rerun the exact tag workflow, record the new exact run attempt, and repeat the checks. After immutable publication, `accept` does not trust the release tarball as its own source authority: it reproduces the lifecycle-disabled pack and reviewed notes from the exact clean tag, requires exact equality, validates the four durable public assets through their checksum and SPDX contracts, and dispatches a new exact lease run for executable public-URL and runtime-inventory acceptance. This post-expiry path validates the immutable public bundle semantically; prepublication byte identity to the original Actions artifact was established by the publishing run and cannot be reconstructed after that artifact expires.

The staging workflow safely resumes one exact draft and replaces the four expected assets with accepted bytes. If the draft has wrong metadata or unexpected extra assets, first read its numeric ID, tag, draft state, and asset list through the GitHub API. Delete only that confirmed unpublished `v0.1.0` draft, leave the tag untouched, rerun the tag workflow, and use its new exact run attempt. Never use this cleanup path after publication.
