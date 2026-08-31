# Public CLI release control

Status: prepared but blocked before publication.

The former `v0.1.0` beta process depended on the HRA v0 Vercel deployment, its public fallback, and its paired provider readbacks. That dependency became invalid when HRA v0's Vercel and Convex resources were permanently retired. At retirement, `hraness/hra` had no `v0.1.0` tag, no draft release for that tag, and no published `v0.1.0` release.

The former public `release:candidate` and `release:publish` package entries remain removed. Their fallback-bound implementation and deterministic tests under `scripts/` remain only as a safety and design record. They must not be invoked directly to create a candidate, tag, draft, workflow lease, publication, or provider mutation.

The replacement `.github/workflows/release.yml` is an artifact-only current-repository path. It does not read or mutate Vercel, Convex, DNS, hosted aliases, or any retired HRA v0 resource. It requires an immutable annotated stable version tag whose peeled commit is contained in reviewed `main`, runs the complete repository gate, builds one npm tarball, verifies that same tarball on macOS and Linux, creates and proves an immutable GitHub Release from the tarball plus `SHA256SUMS`, publishes that tarball through npm trusted publishing, and admits the public bytes and provenance before success.

Publication is still blocked. Stable HRA must replace its GitHub `@hraness/oh#v0.2.0` runtime dependency with exact registry version `0.2.4`, after that OIDC-published version is publicly available as Oh's `latest`. The `@hraness/hra` npm package also must exist before its GitHub trusted publisher can be configured. Do not attempt publication until that dependency transition is reviewed, the separate first-package bootstrap is complete, trusted publishing names this repository and `release.yml`, and a clean release rehearsal passes.

The README and website remain explicit that the beta is not live. This control-layer preparation does not make the displayed install command usable and does not authorize a tag, draft, Release, npm publication, website claim change, or hosted-service mutation. Preserve old local receipts, intents, and evidence files as historical records; they do not authorize replay.

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
drafts within a fixed bound, rejects duplicates or extra assets, verifies existing asset
names, sizes, digests, and downloaded bytes, uploads only a missing tarball or checksum,
then publishes and re-reads the immutable Latest Release by the same numeric ID. Final
success also requires that no residual draft for the tag remains. A mismatched, ambiguous,
or coexisting draft is terminal and is never overwritten, deleted, or treated as retry
authority.

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

The first npm publication is a separate bootstrap ceremony because npm cannot attach a
trusted publisher to a package coordinate that does not yet exist. It must publish only a
non-executable coordinate seed, `@hraness/hra@0.1.0-bootstrap.0`, while requesting the
`bootstrap` dist-tag. npm also assigns `latest` to the first published version of a new
package coordinate even when the publication requests another tag, so the seed initially
resolves through both `bootstrap` and `latest`; that registry invariant is not a stable
promotion. The seed must never consume stable `0.1.0`, expose the HRA executable, or reuse
any retained stable tarball. The ceremony requires explicit operator approval and the
repository variable
`HRA_APPROVE_NPM_PUBLICATION=publish:@hraness/hra@0.1.0` before stable publication.

After the coordinate exists, an operator using npm CLI 11.15.0 or newer configures the sole
trusted publisher as GitHub repository `hraness/hra`, workflow `release.yml`, publish-only,
with no npm environment. Stable `0.1.0` remains the first OIDC/provenance publication. The
stable workflow never performs the bootstrap or grants a second publisher. Its successful
publication replaces the bootstrap seed as `latest` with exact stable `0.1.0`, while the
seed remains available only as the explicitly named `bootstrap` version and dist-tag.
