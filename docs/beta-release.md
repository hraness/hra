# Public CLI release control

Status: prepared but blocked before publication.

The former `v0.1.0` beta process depended on the HRA v0 Vercel deployment, its public fallback, and its paired provider readbacks. That dependency became invalid when HRA v0's Vercel and Convex resources were permanently retired. At retirement, `hraness/hra` had no `v0.1.0` tag, no draft release for that tag, and no published `v0.1.0` release.

The former public `release:candidate` and `release:publish` package entries remain removed. Their fallback-bound implementation and deterministic tests under `scripts/` remain only as a safety and design record. They must not be invoked directly to create a candidate, tag, draft, workflow lease, publication, or provider mutation.

The replacement `.github/workflows/release.yml` is an artifact-only current-repository path. It does not read or mutate Vercel, Convex, DNS, hosted aliases, or any retired HRA v0 resource. It requires an immutable annotated stable version tag whose peeled commit is contained in reviewed `main`, runs the complete repository gate, builds one npm tarball, verifies that same tarball on macOS and Linux, publishes it through npm trusted publishing, creates an immutable GitHub Release from the same tarball plus `SHA256SUMS`, and admits the public bytes and provenance before success.

Publication is still blocked. `@hraness/oh` is a GitHub runtime dependency and has no public npm coordinate, while the replacement gate accepts only exact registry runtime versions. The `@hraness/hra` npm package also must exist before its GitHub trusted publisher can be configured. Do not create an HRA version tag or attempt publication until Oh is published and pinned by exact registry version, the first-package bootstrap is reviewed, trusted publishing names this repository and `release.yml`, and a clean release rehearsal passes.

The README and website remain explicit that the beta is not live. This control-layer preparation does not make the displayed install command usable and does not authorize a tag, draft, Release, npm publication, website claim change, or hosted-service mutation. Preserve old local receipts, intents, and evidence files as historical records; they do not authorize replay.

## Repository release governance

Release automation assumes GitHub protects `main` with required pull-request review,
required CODEOWNERS review for release-authority files, required successful CI, dismissal
of stale approvals, conversation resolution, linear history, and administrator enforcement.
The repository must also protect `v*` tags against direct creation, update, force-push,
and deletion. A release operator creates one annotated stable-semver tag only after the
reviewed commit is the protected `main` head; no workflow, administrator, or retry path
may bypass those rules. The workflow independently binds the exact tag ref, annotated
tag object, peeled commit, checked-out commit, and ancestry in current protected `main`.
Any positive rerun attempt may finish the same release only after re-proving that exact
tag object, commit, artifact checksum, and `main` ancestry; it may never substitute bytes,
a tag, a commit, or a different workflow run.

The first npm publication is a separate bootstrap ceremony because npm cannot attach a
trusted publisher to a package coordinate that does not yet exist. That bootstrap must
publish a non-`latest` prerelease under explicit operator approval and then configure the
npm trusted publisher for `hraness/hra` and `.github/workflows/release.yml`. A later,
separately versioned stable release is the first OIDC/provenance publication; the stable
workflow never silently performs the bootstrap or converts a bootstrap version into
`latest`.
