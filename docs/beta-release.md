# Public CLI release control

Status: immutable public `v0.2.1` release admitted through the durable retry contract.

The former `v0.1.0` beta process depended on the HRA v0 Vercel deployment, its public fallback, and its paired provider readbacks. That dependency became invalid when HRA v0's Vercel and Convex resources were permanently retired. At retirement, `hraness/hra` had no `v0.1.0` tag, no draft release for that tag, and no published `v0.1.0` release.

The former public `release:candidate` and `release:publish` package entries remain removed. Their fallback-bound implementation and tests, `scripts/release-candidate.ts` and `scripts/publish-beta-release.ts`, were deleted on 2026-09-02: no package script or workflow referenced them, and their tests ran on every pull request. The failure records below and Git history are the design record. Nothing may recreate a candidate, tag, draft, workflow lease, publication, or provider mutation from that path.

The replacement `.github/workflows/release.yml` is an artifact-only current-repository path. It does not read or mutate Vercel, Convex, DNS, hosted aliases, or any retired HRA v0 resource. It requires an immutable annotated stable version tag whose peeled commit is contained in reviewed `main`. It does not rerun the repository gate. Instead, `scripts/check-commit-ci-run.ts` reads the GitHub Actions API with `actions: read` and admits packaging only when the CI workflow has exactly one `push` run on the default branch whose head is that exact commit, that run completed with conclusion `success`, and its `Required` job for the same attempt and commit completed with conclusion `success`. A tag on a commit CI never checked, checked with any other result, or is still checking cannot package or publish; the operator reruns the release after CI is green. On Linux the verifier still downloads and checksum-verifies the same pinned Zig toolchain as CI, rebuilds and verifies the native authority-supervisor artifacts, enables and proves an isolated user namespace, and runs the focused native custody test; an always-running cleanup restores the runner restriction. It then builds one npm tarball in the runner's temporary directory, outside the checked-out public tree, verifies that same tarball on macOS and Linux, and uses the pinned npm client to prove the package-specific trusted-publisher exchange with a non-publishing dry run. Only after that reversible proof may it create and prove an immutable GitHub Release from the tarball plus `SHA256SUMS`, publish the same tarball through npm trusted publishing, and admit the public bytes and provenance before success.

The dependency and npm-authority prerequisites are satisfied: HRA pins the immutable public registry release `@hraness/oh@0.2.7`, the `@hraness/hra` coordinate completed its non-executable bootstrap, and npm trusted publishing names repository `hraness/hra` and workflow `release.yml`. Stable `@hraness/hra@0.1.6` is authoritative after reviewed source reached `main`, the clean single-branch release gate passed, annotated `v0.1.6` tag object `f125f3dc3d77d41d905327faa1cf825e8f3b0b92` was created, and the trusted workflow admitted the exact npm and GitHub artifacts. The three workflow attempts addressed only that exact tag, commit, and tarball under the retry controls below; none substituted another release identity.

Every release job starts from a shallow checkout of only the requested tag or its verified commit, then explicitly unshallows only reviewed `main` and that exact annotated tag. It fails unless those are the only two refs in the runner. The unchanged package gate can therefore scan every local ref and every commit in the complete governed release ancestry without importing unrelated remote branches, deleted local-only tags, or automatic tag following.

Ordinary pull-request and `main` CI uses the same governed-history principle without release-tag authority. It checks out exact `github.sha` shallowly with no tags or persisted credentials, validates that lowercase commit identity, unshallows only that exact commit into `refs/remotes/ci/verified`, and fails unless `HEAD` and the runner's sole ref resolve to it. For a pull request, that commit is GitHub's exact synthetic merge; for a push, it is the exact pushed commit. The package gate still scans `rev-list --all`, including the complete tested ancestry and its merge resolution, while unrelated concurrent branch heads cannot enter or race the check.

The canonical README and website are the two-phase public surface: “Immutable local CLI release; hosted sync not yet live.” The website and the `v0.2.1` local CLI are live; the install command names the immutable `v0.2.1` GitHub Release and verified archive. This public-copy follow-up marks the tag live without changing the published `v0.2.1` bytes. The admitted `v0.2.0` tag, tarball, checksum, npm version, and provenance remain immutable historical evidence. Neither phase claimed that hosted sync was available; the hosted invite-only beta went live separately on 2026-09-03 and the public copy now says so. Preserve old local receipts, intents, and evidence files as historical records; they do not authorize replay or any hosted-service mutation.

## Immutable v0.1.0 failure record

The annotated `v0.1.0` tag object `ff3248801789d778829f18a55051443888fbc960` remains immutable and peels to commit `0e9287bc2ead3af2d432375efb86247455c2223d`. Release workflow run `33363290345`, attempt 1, failed in job `99398751969` at `Run complete repository gate`: the authority-supervisor runtime test could not map an isolated user namespace (`unshare` reported `/proc/self/uid_map: Operation not permitted`) and the supervisor returned `namespace_mapping_failed`.

That run stopped before registry-only package policy, tarball or checksum creation, npm registry preflight, and artifact upload. The unexpanded exact-artifact matrix and the publish job were skipped. It therefore created no npm `0.1.0`, GitHub Release, draft Release, checksum, or retained workflow artifact. The publication variable was deleted after the failure. The tag and run remain historical evidence only: they must not be updated, deleted, recreated, or treated as authority for a later release.

## Immutable v0.1.1 failure record

The annotated `v0.1.1` tag object `6871f3e98ee22607ebea25531882c75da5ad8778` remains immutable and peels to reviewed `main` commit `2f773e588ec06a4d63811dc330012a32602b347e`. Release workflow run `33368241909`, attempt 1, completed the full verification job and preserved exact artifact `9749194160` with Actions digest `1a6ad2dd73065c01080df47a6c9f9c8de5733cd28ead4b4139c63e065e3e9cba`. Both exact-artifact jobs downloaded those bytes and verified `hraness-hra-0.1.1.tgz` against its inner checksum.

The macOS and Ubuntu jobs then failed identically because the workflow had downloaded the sibling checksum to `artifacts/SHA256SUMS` inside the checked-out repository. The installed-package check correctly scanned the public tree and rejected that extensionless workflow file as `UNREVIEWED_FILE_TYPE`. Ubuntu's user-namespace enable and restoration both succeeded. The publish job was skipped, GitHub had no Release or draft, npm still exposed only `0.1.0-bootstrap.0`, and the exact publication variable was deleted. The tag, run, and retained artifact remain historical evidence only; they must not be retried, updated, deleted, recreated, or treated as publication authority. The `v0.1.2` repair moved generated and downloaded release bytes under `RUNNER_TEMP`, outside the checked-out public tree, without weakening the public-text policy.

## Immutable v0.1.2 partial failure record

The annotated `v0.1.2` tag object `334a5951037ecacb9895a153d76542bce63558b2` remains immutable and peels to reviewed `main` commit `f0a1f4a31c1ebda745d2058c2f00a44e9fcbe5a4`. Release workflow run `33373504473`, attempts 1 and 2, completed the full verification job and both macOS and Ubuntu exact-tarball installation jobs. The run created immutable GitHub Release `379612601`: asset `537702932` contains the 651,743-byte tarball with SHA-256 `9b0fb77ffd6eb4f4535c91ac03c9b91afea7bd44c4c28a2069dabccbc95bfc93`, and asset `537702965` contains the 88-byte checksum file with SHA-256 `c0e3962a9c86b8dbf0d397593a919f5e12a5400c4d8f1a5964058e401c1950b6`.

Both attempts then failed in the npm child after the GitHub Release became immutable. The wrapper had bounded but discarded all npm output, so the historical runs cannot distinguish OIDC exchange rejection from provenance or final registry-write failure. Registry readback proves `@hraness/hra@0.1.2` is absent and both `latest` and `bootstrap` still name `0.1.0-bootstrap.0`. The tag, release, assets, and runs remain unsupported historical evidence only: they must not be retried, updated, deleted, recreated, or treated as a complete publication. The `v0.1.3` forward repair pins Node 24.20.0 with npm 11.19.0, removes setup-node's generated registry credential file, accepts the OIDC bearer endpoint only on GitHub's HTTPS Actions authority with the expected token-service path, isolates npm user and global configuration, proves the exact OIDC exchange before creating another GitHub Release, applies one aggregate output bound, emits only bounded allowlisted failure classes, forwards numeric repository-owner identity, and admits that owner identity inside the SLSA predicate.

## Immutable v0.1.3 failure record

The annotated `v0.1.3` tag object `61ebcaf33616bc29675053465725bc294f06f9d2` remains immutable and peels to reviewed `main` commit `eef84596ec3891bcd29691d087449641dfda7e62`. Release workflow run `33411496909`, attempt 1, completed the full verification job and both macOS and Ubuntu exact-tarball installations. Retained Actions artifact `9765501271` has digest `sha256:df1f40d36e19b92b92c8d6b256e49c7caa54ed5850bf353dec2c38995b3d449b`; it carries the 651,739-byte tarball with SHA-256 `cd7847d3e7c7369f05ad35bb80372e7a648875fc2201b1490591f9028db549ed` and the 88-byte checksum file with SHA-256 `371394f881aa1f0ed692ccf287c277571f2e0e78892f84a1652b5d3fea540f6c`.

Publish job `99553962517` stopped at `Prove npm trusted-publisher exchange without publication`. The reviewed boundary rejected GitHub's newer hosted-runner OIDC path before starting npm, so the later GitHub Release, npm publication, and public-admission steps were skipped. Readback proves that no `v0.1.3` GitHub Release or draft and no npm `0.1.3` exist; `latest` and `bootstrap` still name `0.1.0-bootstrap.0`. The publication variable was deleted. The tag, run, and retained workflow artifact remain unsupported immutable evidence and must not be retried, updated, deleted, recreated, or treated as publication authority. The `v0.1.4` repair preserves the GitHub HTTPS authority boundary while accepting both the legacy distributed-task path and the bounded current hosted-runner `/idtoken/` path, and permits only one `api-version=2.0` query parameter.

## Immutable v0.1.4 failure record

The annotated `v0.1.4` tag object `5c7e6add3062096c9545b10eaafddfd43f0b903e` remains immutable and peels to reviewed `main` commit `586f954945f614c00efd12f13a0d43c6f5bb809c`. Release workflow run `33417025171`, attempts 1 and 2, completed the full verification job and both macOS and Ubuntu exact-tarball installations. Retained Actions artifact `9767593195`, named `hra-release-1`, is 652,281 bytes with digest `sha256:6816535110350f9bb3d43424caf05f04cc930481a64d9dd4917e0b8e4e7fa4b4` and expires at `2026-09-07T17:04:20Z`; it carries the 651,736-byte tarball with SHA-256 `d9c80317a85139347ec482d7b811aef57045af8175c72cc21e259d0e23249784` and the 88-byte `SHA256SUMS` file with SHA-256 `2c67963d34862b06edb818c72644db08585d618d72c17baf3d531a9520dd1a1c`.

Publish jobs `99572060480` and `99574351110` each stopped at `Prove npm trusted-publisher exchange without publication` with `trusted_exchange_not_proven`. GitHub's OIDC endpoint identity proof had passed, but npm 11.19.0 never reached OIDC: the boundary assigned both `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` to `/dev/null`, and npm rejected double-loading `/dev/null` as both the user and global configuration source before initialization. The GitHub Release, npm publication, and public-admission steps were skipped. Readback proves no `v0.1.4` GitHub Release and no npm `0.1.4` exist; `latest` and `bootstrap` still name `0.1.0-bootstrap.0`. The publication variable was deleted. The tag, run, and retained workflow artifact remain unsupported immutable evidence and must not be retried, updated, deleted, recreated, or treated as publication authority. The `v0.1.5` forward repair creates distinct private mode-`0600` user and global npm configuration files in a fresh mode-`0700` directory, adds bounded allowlisted `publisher_configuration_failed` and `publisher_configuration_cleanup_failed` classes, and still requires npm's exact `Successfully retrieved and set token` marker before GitHub publication.

## Immutable v0.1.5 successful release record

Annotated `v0.1.5` tag object `2503c4cccd52f4de9e8fb966f8050a08d26a3d06` peels to reviewed `main` commit `8e9b253bcebe07fc08289f033aaaeda6c574774d`, merged through PR 49. Release workflow run `33427625936`, attempts 1 and 2, completed the full verification job and both exact-platform installations. Attempt 1 publish job `99607830579` proved the npm trusted-publisher exchange, created immutable GitHub Release `379986294`, and published npm `@hraness/hra@0.1.5`, but a bounded post-publication verification request ended with `TimeoutError` before final admission. The one-shot publication variable was immediately deleted. Registry and release readback then proved the exact version existed, `latest` named `0.1.5`, provenance metadata was present, and no second publication authorization was required.

Attempt 2 publish job `99611394355` observed the registry state as exact, skipped the first-publication OIDC dry run, re-proved the existing GitHub Release and npm package, verified provenance from the same workflow run, and completed final public admission. Retained Actions artifact `9771995410`, named `hra-release-2`, is 652,272 bytes with digest `sha256:5e52442c02ee3fb8abee520df41a19e48ef9047f24eb6f160ece1686b2331efb` and expires at `2026-09-07T19:14:29Z`. GitHub asset `538406590` is the 651,736-byte `hraness-hra-0.1.5.tgz` with SHA-256 `48f579f8bee54dbf87ccd5f54ff5d4bf89abd9ba9025280344ad0fe9bfdc57c6`; asset `538406604` is the 88-byte `SHA256SUMS` file with SHA-256 `a947561b784a41473d5728dfcc96cc6e9d50ba7b542d0010faf3997a041a7091`. npm exposes those same tarball bytes with integrity `sha512-Kv5JY5hbijho5MW79s7bygLb120pQ6RM8EV7aHycETK/hImL0/UQQuC9f72Vtgt4NSF39Glh1EVBFQXdddeGTw==` and SHA-1 `f598c36c331f87676382dfffd19907a8e9107b8f`; independent download comparison is byte-identical. The tagged installer runtime has SHA-256 `d684f9b7cbda8eabe6e1d217fca14acbe93bd888a8c8d03391ea91129696c1f1`, an isolated public installation returned `hra-install-safe`, and the installed binary reported `hra 0.1.5`. The publication variable remains absent. `v0.1.5` was the supported public CLI beta; hosted sync remains unavailable.

## Immutable v0.1.6 successful release record

Annotated `v0.1.6` tag object `f125f3dc3d77d41d905327faa1cf825e8f3b0b92` peels to reviewed `main` commit `b787e4d767d9bc95a70952e1002c150f5f33661c` with tree `f46d779d7c56cf011757471790b4c5cd72cf5747`, merged through PR 65. Exact-main CI run `33562319207` passed. Release workflow run `33562952832`, attempts 1 through 3, completed the full verification job and both exact-platform installations. Attempt 1 verifier job `100039504965`, macOS job `100042411399`, and Ubuntu job `100042411450` reached publish job `100042677957`, which created the immutable GitHub Release and published npm `@hraness/hra@0.1.6`; final provenance admission received HTTP 404 from npm's Sigstore attestations endpoint and did not admit the run. The one-shot publication variable was removed.

Attempt 2 used verifier job `100043256132`, macOS job `100043256791`, Ubuntu job `100043256627`, and publish job `100043256070`; the publisher preflight stopped with `version_conflict` after the exact npm version already existed. Attempt 3 verifier job `100043668390`, macOS job `100045311262`, Ubuntu job `100045311412`, and publish job `100045528708` observed the exact existing registry state, skipped the first-publication OIDC dry run, re-proved the GitHub Release, npm package, and provenance, and completed final public admission.

Retained Actions artifact `9822648569`, named `hra-release-3`, is 658,170 bytes with digest `sha256:4a4b8f796b3facba97b2ef1a92be916d21637060df48451044ac6b736cb464b3` and expires at `2026-09-08T22:08:27Z`. Immutable GitHub Release `380848789`, node `RE_kwDOUAyvX84Ws0qV`, contains asset `540202136`, the 657,619-byte `hraness-hra-0.1.6.tgz` with SHA-256 `c26a9352a8cefd032794a94c0c05c11319897890a78fa4c6e0eb6f2506635aca`, and asset `540202181`, the 88-byte `SHA256SUMS` file with SHA-256 `de24d6c71005c7528562fff09200e529adfa119d4c1f469f46562931ceaf96c9`. npm `latest` names `@hraness/hra@0.1.6` and exposes those same tarball bytes with integrity `sha512-Olb/QneV4Qy4oRabwINocuhakrJLOsm0omCHcFK5bkFqnzCNn5vYd0LplXTEtPxNe+yWqiSBHi+98v+6bLtbZQ==` and SHA-1 `a36bc66b0c727741c0306e695da8a13ce2104704`; provenance is present and independent download comparison is byte-identical. The publication variable remains absent. `v0.1.6` is the supported public CLI beta; hosted sync remains unavailable.

## Immutable v0.2.0 successful release record

Annotated `v0.2.0` tag object `46b4be7610b375fa788c373185c5aa6e6a0b4150` peels to reviewed `main` commit `6584ca1bf45041749e58bce60bff62bbe8cb844c` with tree `516ad881ab1bffafa46f0a9f747117eb28a3c87c`, merged through PR 73 after PR 71 (plan and wave 0) and PR 72 (the superseded `v0.1.7` preparation). Exact-main CI run `33705600758` passed. The tag was created under a temporary repository-admin bypass on the `Immutable version tags` ruleset because GitHub reserves the `v0.1.7` through `v0.1.10` names for the retired v0 repository's immutable releases; the bypass was removed after creation. A throwaway lightweight `v0.2.0` probe tag, pushed and deleted before the annotated tag to confirm the name was free, triggered run `33704483919`, which failed at checkout with no side effects.

Release workflow run `33706170098` needed five attempts. Attempt 1 (verifier job `100495630588`, macOS job `100495944582`, Ubuntu job `100495944629`) failed on macOS at the installed-package check: `hra daemon stop` after the restored PTY shell returned `RECOVERY_REQUIRED` with the immediate daemon-authority diagnostic. The same tree had passed that lifecycle on macOS runners in the PR and exact-main CI runs and on a developer machine, and every later attempt passed it, so it is recorded as a timing flake in the post-shell disconnect path. Attempt 2 (verifier `100497168789`, macOS `100497142110`, Ubuntu `100497143323`, publish `100497352702`) created immutable GitHub Release `381681569` and then stopped at the npm trusted-publishing step because the approval variable still named the superseded `0.1.7`. Attempt 3 (verifier `100498205720`, macOS `100498206375`, Ubuntu `100498206491`, publish `100498205834`) ran with `HRA_APPROVE_NPM_PUBLICATION=publish:@hraness/hra@0.2.0`, published `@hraness/hra@0.2.0`, and failed after publication inside the same step. Attempt 4 (verifier `100498610260`, macOS `100498610815`, Ubuntu `100498610515`, publish `100498610111`) observed that the registry already contained the exact trusted-publisher bytes and stopped at the exchange-proof step. Attempt 5 (verifier `100501506346`, macOS `100501786551`, Ubuntu `100501786715`, publish `100501970570`) observed the exact existing registry state, re-proved the existing GitHub Release and npm package, verified provenance, and completed final public admission.

Retained Actions artifact `9875969848`, named `hra-release-5`, is 675,149 bytes with digest `sha256:278c88c2accc98876731d03ec4e81a6d37542971caa8bc6d8aa78c2bab88262e` and expires at `2026-09-10T02:35:00Z`. Immutable GitHub Release `381681569`, node `RE_kwDOUAyvX84Wv_-h`, contains asset `542063653`, the 674,632-byte `hraness-hra-0.2.0.tgz` with digest `sha256:acc3fce6fbb4a20fea3f72a349db8eb23c47321917e291aa8668ce90c5a66ecc`, and asset `542063671`, the 88-byte `SHA256SUMS` with digest `sha256:bc53dd0c632767104dc23b8881d7c0e343be373e18bcb311ce326112d39b8daa`. npm `latest` names `@hraness/hra@0.2.0`; `bootstrap` still names `0.1.0-bootstrap.0`. `v0.2.0` is the supported public CLI beta.

## Immutable v0.2.1 successful release record

Annotated `v0.2.1` tag object `f1c0b54a9c5c30ddb891032d19fddb58b1fa3219` peels to reviewed `main` commit `88b0567bd731b429db255e3cf454c320350d96c6` with tree `258524916c11a0078d040c927313a943d54d4a98`, merged through PR 87 after PR 84 (the expired-access-token transport fix and its inventory re-pin); PR 85 and PR 86 were the same preparation superseded by GitHub rebase conflicts. Exact-main CI run `33802285588` passed. The throwaway lightweight `v0.2.1` probe tag was created without any ruleset bypass, which showed that the `Immutable version tags` ruleset restricts only update and deletion; it triggered run `33803078820`, which failed at the annotated-tag verification with no side effects. Replacing the probe with the annotated tag needed the temporary repository-admin bypass, which was removed immediately after the push.

Release workflow run `33803212691` needed five attempts. Attempt 1 (verifier job `100807395115`, macOS job `100807802302`, Ubuntu job `100807802313`, publish job `100808120722`) created immutable GitHub Release `382318983` and stopped at the npm trusted-publishing step because the run had started before `HRA_APPROVE_NPM_PUBLICATION=publish:@hraness/hra@0.2.1` was set. Attempt 2 (verifier `100808663223`, macOS `100808663701`, Ubuntu `100808707624`, publish `100808662986`) published `@hraness/hra@0.2.1` through the trusted-publisher exchange and then failed inside the same step because the registry did not expose the publication as `latest` within the bounded readback window; the version and `latest` tag appeared about ten minutes later and the tarball bytes became downloadable later still. Attempts 3 (verifier `100810189660`, macOS `100810190894`, Ubuntu `100810190563`, publish `100810190404`) and 4 (verifier `100810646915`, macOS `100810646716`, Ubuntu `100810646857`, publish `100810646677`) were failed-job reruns that reused attempt 1's `absent` preflight state and stopped at the exchange-proof dry run with `version_conflict`. Attempt 5 (verifier `100811712966`, macOS `100812167959`, Ubuntu `100812167768`, publish `100812486546`) was a full rerun after the registry served the exact bytes; it observed the exact existing registry state, re-proved the existing GitHub Release and npm package, verified provenance, and completed final public admission. The one-shot publication variable was removed afterwards.

Retained Actions artifact `9912412227`, named `hra-release-5`, is 675,689 bytes with digest `sha256:25091824b7b39876a95d89aadad7fc1ca09b5d2257361559d71601ab3c2898b9` and expires at `2026-09-10T20:51:13Z`; attempt 1's `hra-release-1` artifact is no longer listed on the run. Immutable GitHub Release `382318983`, node `RE_kwDOUAyvX84WybmH`, contains asset `543311730`, the 675,160-byte `hraness-hra-0.2.1.tgz` with digest `sha256:daee36756d6c8fc8d14aa48f417b18f671951ada58f20c6d3f0217f16691c1be`, and asset `543311784`, the 88-byte `SHA256SUMS` with digest `sha256:9533992bac958384444fdcf5bc39e9c7eee613c17bf3872058e64dac44d96a89`. npm `latest` names `@hraness/hra@0.2.1`; `bootstrap` still names `0.1.0-bootstrap.0`. `v0.2.1` is the supported public CLI beta and the first release admitted while hosted sync is live.

## Reserved version tag names

GitHub immutable releases reserve a tag name forever once an immutable release used it, and that reservation survives deleting the release and even deleting and recreating a repository with the same name. The retired HRA v0 repository published immutable releases `v0.1.7`, `v0.1.8`, `v0.1.9`, and `v0.1.10` under the `hraness/hra` name, so those tags cannot be created in this repository: a push is refused with `Cannot create ref due to creations being restricted` even for an actor who bypasses every repository ruleset. The first release after `v0.1.6` is therefore `v0.2.0`. Before preparing any release, probe the intended tag name with a throwaway lightweight tag that is deleted immediately, and keep the `Immutable version tags` ruleset's bypass list empty except during that governed creation.

## Repository release governance

Release automation assumes GitHub protects `main` with required pull-request review,
required CODEOWNERS review for release-authority files, required successful CI, dismissal
of stale approvals, conversation resolution, linear history, and administrator enforcement.
The repository must allow exactly one governed creation of each `v*` tag and prohibit
tag update, force-push, and deletion without a bypass path. A release operator may create
one annotated stable-semver tag before or after the reviewed commit reaches `main`; no
workflow, administrator, or retry path may update, recreate, or delete that tag object.
Publication is admitted only after the workflow independently binds the exact tag ref,
annotated tag object, peeled commit, checked-out commit, and ancestry in current reviewed
`main`.
Any positive rerun attempt may finish the same release only after re-proving that exact
tag object, commit, artifact checksum, and `main` ancestry; it may never substitute bytes,
a tag, a commit, or a different workflow run.

GitHub publication creates one deterministic draft before uploading. A later attempt may
resume only one draft created by the same workflow run with the exact numeric release ID,
tag, title, canonical identity body, tag object, commit, and artifact manifest. The body
records repository path and numeric ID, workflow ref, run ID, creation and publication
attempts, and both asset names, sizes, and SHA-256 digests. It inventories
drafts exhaustively within ten bounded pages, rejects duplicates or extra assets, verifies existing asset
names, sizes, digests, and downloaded bytes, uploads only a missing tarball or checksum,
then publishes and re-reads the immutable Latest Release by the same numeric ID. Final
success also requires that no residual draft for the tag remains. A mismatched, ambiguous,
or coexisting draft is terminal and is never overwritten, deleted, or treated as retry
authority.

GitHub can expose a newly created draft or a just-published Release through its direct and
inventory endpoints at different times. The writer therefore polls only for bounded exact
convergence: after creation, an empty inventory may become the one returned draft ID; after
publication, the same ID may transiently remain in draft inventory only while a direct
read is still the exact complete draft or exact publication with the reviewed asset bytes.
Any foreign ID, duplicate, edited identity, different bytes, or state outside that narrow
transition fails immediately.

A rerun may create a draft only when every earlier attempt's bounded GitHub Jobs API record
proves that the exact publication step was skipped. The publisher checks that witness once
while planning and again immediately before the POST, binds each job to this run, attempt,
workflow, and verified commit, and grants the job only `actions: read` in addition to its
existing writer permissions. If an earlier publication step may have run, a later attempt
may only observe and recover its exact same-run draft or publication. This deliberately
prefers safety over liveness when provider state never appears after an ambiguous attempt.

The verification job exports GitHub's positive numeric artifact ID and the upload action's
lowercase digest. Consumers reject malformed values and download only that numeric ID; the
outer digest is a transport assertion, not independent release authority. Authority over
the consumed bytes comes from the downloaded inner `SHA256SUMS`, which is revalidated
against the exact tarball before any publication step.

The privileged publish job's trusted computing base is broader than either writer script.
It includes the reviewed workflow, its SHA-pinned `actions/checkout`, `setup-bun`,
`setup-node`, upstream `upload-artifact`, and `download-artifact` revisions, the
checked-out verification and publication code they execute, the installed locked
toolchain, and the GitHub-hosted runner. The job's npm OIDC permission makes every step
in that job security-sensitive.
The GitHub token is not job-wide: it is exposed only to the exact remote-authority
revalidation, GitHub Release publication/readback, and final public-admission steps.

The coordinate bootstrap was a separate ceremony because npm cannot attach a
trusted publisher to a package coordinate that does not yet exist. It published only a
non-executable coordinate seed, `@hraness/hra@0.1.0-bootstrap.0`, while requesting the
`bootstrap` dist-tag. npm also assigns `latest` to the first published version of a new
package coordinate even when the publication requests another tag, so the seed initially
resolves through both `bootstrap` and `latest`; that registry invariant is not a stable
promotion. The seed did not consume stable `0.1.0`, `0.1.1`, `0.1.2`, `0.1.3`, `0.1.4`, `0.1.5`, `0.1.6`, `0.2.0`, or `0.2.1`, expose the HRA executable, or reuse
any retained stable tarball. The completed ceremony required explicit operator approval and the
repository variable
`HRA_APPROVE_NPM_PUBLICATION=publish:@hraness/hra@0.2.1` before stable publication.

After the coordinate existed, an operator using npm CLI 11.19.0 verified the sole
trusted publisher as GitHub repository `hraness/hra`, workflow `release.yml`, publish-only,
with no npm environment. Stable `v0.1.5` is the first complete OIDC/provenance publication,
stable `v0.1.6` was the second, stable `v0.2.0` the third, and stable `v0.2.1` is the current complete publication. The stable workflow never performs
the bootstrap or grants a second publisher. Exact `0.1.6` publication moved `latest` from
stable `0.1.5` to stable `0.1.6`, while the bootstrap
seed remains available only as the explicitly named `bootstrap` version and dist-tag.
Registry admission accepts either exact version metadata or a bounded full package document.
Package documents must carry the exact package identity and own exact version entry; reads
of `/latest` additionally require `dist-tags.latest` to name `0.1.6`. This keeps transient
registry response shapes from weakening the distinction between version existence and
stable latest promotion.

Fulcio signer admission preserves raw ASCII matching for legacy GitHub workflow extension
OIDs `.2` through `.6`. Current V2 claims from `.11` onward are matched as one canonical
short-form DER UTF8String whose payload is bounded nonempty ASCII. The repository-subject
claim remains mandatory and exact: repository path `hraness/hra`, numeric owner ID
`307125679`, numeric repository ID `1343008607`, and ref `refs/tags/v0.1.6`. The generated SLSA
internal parameters must separately preserve exact event `push`, repository ID `1343008607`,
and owner ID `307125679`. The encoding repair does not
drop or weaken any workflow, commit, ref, run, visibility, owner, or repository claim.

## Installer digest pins between releases

The transactional installer embeds the SHA-256 of `src/cli.ts` and of `src/install-normalizer.ts`, and the public one-line command carries the SHA-256 of `src/install-preflight-runtime.ts` at the released tag. Between releases, any change to the CLI entry point or the normalizer must be followed by `bun run install-pins:update`, which rewrites the embedded digests so a locally packed archive still passes the local preflight; `bun run check` fails until that happens. The public command's digest and URLs keep naming the last released tag until release preparation moves them, and the tag workflow's package check proves under the tag ref that the working tree's runtime bytes are exactly the bytes the public command names.
