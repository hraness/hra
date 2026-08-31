# Public CLI release control

Status: durable `v0.1.1` forward-release and retry contract.

The former `v0.1.0` beta process depended on the HRA v0 Vercel deployment, its public fallback, and its paired provider readbacks. That dependency became invalid when HRA v0's Vercel and Convex resources were permanently retired. At retirement, `hraness/hra` had no `v0.1.0` tag, no draft release for that tag, and no published `v0.1.0` release.

The former public `release:candidate` and `release:publish` package entries remain removed. Their fallback-bound implementation and deterministic tests under `scripts/` remain only as a safety and design record. They must not be invoked directly to create a candidate, tag, draft, workflow lease, publication, or provider mutation.

The replacement `.github/workflows/release.yml` is an artifact-only current-repository path. It does not read or mutate Vercel, Convex, DNS, hosted aliases, or any retired HRA v0 resource. It requires an immutable annotated stable version tag whose peeled commit is contained in reviewed `main`. Before the complete repository gate on Linux, it downloads and checksum-verifies the same pinned Zig toolchain as CI, rebuilds and verifies the native authority-supervisor artifacts, enables and proves an isolated user namespace, and runs the focused native custody test; an always-running cleanup restores the runner restriction. It then builds one npm tarball, verifies that same tarball on macOS and Linux, creates and proves an immutable GitHub Release from the tarball plus `SHA256SUMS`, publishes that tarball through npm trusted publishing, and admits the public bytes and provenance before success.

The dependency and npm-authority prerequisites are satisfied: HRA pins the immutable public registry release `@hraness/oh@0.2.7`, the `@hraness/hra` coordinate completed its non-executable bootstrap, and npm trusted publishing names repository `hraness/hra` and workflow `release.yml`. Stable `@hraness/hra@0.1.1` becomes authoritative only when reviewed source reaches `main`, the clean single-branch release gate passes, an immutable annotated `v0.1.1` tag exists, and the trusted workflow admits the exact npm and GitHub artifacts. A later workflow attempt may complete that same exact release under the retry controls below; it may not substitute another tag, commit, or tarball.

Every release job starts from a shallow checkout of only the requested tag or its verified commit, then explicitly unshallows only reviewed `main` and that exact annotated tag. It fails unless those are the only two refs in the runner. The unchanged package gate can therefore scan every local ref and every commit in the complete governed release ancestry without importing unrelated remote branches, deleted local-only tags, or automatic tag following.

The canonical README and website are the two-phase public surface: “Immutable local CLI release; hosted sync not yet live.” The website is live and the local CLI tag remains `release-ready` until exact release admission; the install command is explicitly conditional on GitHub exposing the immutable `v0.1.1` Release and verified archive. A public-copy/package-inventory-only follow-up may mark the tag live after admission while leaving the already-published `v0.1.1` bytes immutable. Neither phase claims that hosted sync is available. Preserve old local receipts, intents, and evidence files as historical records; they do not authorize replay or any hosted-service mutation.

## Immutable v0.1.0 failure record

The annotated `v0.1.0` tag object `ff3248801789d778829f18a55051443888fbc960` remains immutable and peels to commit `0e9287bc2ead3af2d432375efb86247455c2223d`. Release workflow run `33363290345`, attempt 1, failed in job `99398751969` at `Run complete repository gate`: the authority-supervisor runtime test could not map an isolated user namespace (`unshare` reported `/proc/self/uid_map: Operation not permitted`) and the supervisor returned `namespace_mapping_failed`.

That run stopped before registry-only package policy, tarball or checksum creation, npm registry preflight, and artifact upload. The unexpanded exact-artifact matrix and the publish job were skipped. It therefore created no npm `0.1.0`, GitHub Release, draft Release, checksum, or retained workflow artifact. The publication variable was deleted after the failure. The tag and run remain historical evidence only: they must not be updated, deleted, recreated, or treated as authority for `v0.1.1`.

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
promotion. The seed did not consume stable `0.1.0` or `0.1.1`, expose the HRA executable, or reuse
any retained stable tarball. The completed ceremony required explicit operator approval and the
repository variable
`HRA_APPROVE_NPM_PUBLICATION=publish:@hraness/hra@0.1.1` before stable publication.

After the coordinate existed, an operator using npm CLI 11.15.0 or newer configured the sole
trusted publisher as GitHub repository `hraness/hra`, workflow `release.yml`, publish-only,
with no npm environment. Stable `0.1.1` remains the first OIDC/provenance publication. The
stable workflow never performs the bootstrap or grants a second publisher. Its successful
publication replaces the bootstrap seed as `latest` with exact stable `0.1.1`, while the
seed remains available only as the explicitly named `bootstrap` version and dist-tag.
Registry admission accepts either exact version metadata or a bounded full package document.
Package documents must carry the exact package identity and own exact version entry; reads
of `/latest` additionally require `dist-tags.latest` to name `0.1.1`. This keeps transient
registry response shapes from weakening the distinction between version existence and
stable latest promotion.

Fulcio signer admission preserves raw ASCII matching for legacy GitHub workflow extension
OIDs `.2` through `.6`. Current V2 claims from `.11` onward are matched as one canonical
short-form DER UTF8String whose payload is bounded nonempty ASCII. The repository-subject
claim remains mandatory and exact: repository path `hraness/hra`, numeric owner ID
`307125679`, numeric repository ID `1343008607`, and ref `refs/tags/v0.1.1`. The encoding repair does not
drop or weaken any workflow, commit, ref, run, visibility, owner, or repository claim.
