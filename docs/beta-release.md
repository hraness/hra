# Beta release

The `v0.1.0` release has two explicit irreversible steps. Pushing the protected `v0.1.0` tag is the version-identity commit point because repository rules provide no supported update or deletion rollback. Undrafting the accepted release then makes its metadata and assets immutable. GitHub Actions verifies the exact current `main` commit, builds and accepts the tarball, generates both SPDX records, creates or resumes one draft release, replaces its four assets with the accepted bytes, reads every asset back, and stops. The built-in Actions token never publishes the draft because it cannot read the repository's immutable-release setting.

Publish only from a clean checkout of the accepted commit with an authenticated GitHub CLI session that can read repository administration settings. Do not copy a broad personal token into Actions.

## Stage the draft

Complete hosted acceptance, final domain cutover, and the `release-ready` public-content change first. Record the exact merged and deployed new-HRA commit as `N_COMMIT`. Create `v0.1.0` at `N_COMMIT` and push that one tag. The Release workflow must finish with `Stage verified release draft` successful.

Record the exact workflow run ID and attempt from GitHub. Do not select “latest.” The publication command checks repository ID `1343008607`, path `hraness/hra`, workflow name and path, tag push, run ID and attempt, head commit, successful conclusion, and the one unexpired `hra-release-v0.1.0` artifact.

## Publish

From a clean `main` checkout at `N_COMMIT`, run:

```sh
bun run release:publish -- publish \
  --tag v0.1.0 \
  --run-id <exact-run-id> \
  --run-attempt <exact-run-attempt> \
  --expected-commit <N_COMMIT> \
  --gh-cli /opt/homebrew/bin/gh \
  --acknowledge-immutable-publication
```

Before publication, the operator downloads the exact one-day Actions artifact; validates its exact file set, checksums, artifact-identity SPDX record, Ubuntu 24.04 x64 runtime SPDX inventory, package tree, and isolated install; compares every draft asset and all release metadata; requires the REST release record to be `draft: true` and `immutable: false`; re-resolves the fully qualified tag and `heads/main`; reads immutable-release enforcement with the local admin session; and requires a direct nonredirecting HTTP 200 from the canonical `hra.sh` generation-1 marker at `N_COMMIT`.

Undrafting is the publication commit point; the protected tag push is the earlier version-identity commit point. The operator PATCHes the numeric release ID whose metadata and assets it just accepted; it never resolves the tag again for the mutation. It then requires that same REST release record to be `draft: false` and `immutable: true`, with unchanged metadata and bytes, anonymously downloads and digest-verifies the public tarball, and performs the exact-URL install, version check, production-tree policy, and offline doctor in isolated state.

Success prints one bounded JSON value with status `published`. A refusal in phase `before_publication` proves only that this invocation did not send the undraft PATCH. Read the exact numeric release and its current draft and immutable fields before any cleanup; another actor or a prior interrupted invocation may already have crossed the publication commit point. An ambiguous undraft reports `publication_unknown`; inspect the exact release before doing anything else.

## Acceptance recovery

If publication succeeded but a later readback or public-route check failed, never delete, rewrite, or replace the immutable release. From a clean checkout of `N_COMMIT`, retry only acceptance:

```sh
bun run release:publish -- accept \
  --tag v0.1.0 \
  --run-id <exact-run-id> \
  --run-attempt <exact-run-attempt> \
  --expected-commit <N_COMMIT> \
  --gh-cli /opt/homebrew/bin/gh
```

The Actions artifact is retained for one day. Publish or complete acceptance while it remains available. If it expires before the publication commit point, rerun the exact tag workflow, record the new exact run attempt, and repeat the checks.

The staging workflow safely resumes one exact draft and replaces the four expected assets with accepted bytes. If the draft has wrong metadata or unexpected extra assets, first read its numeric ID, tag, draft state, and asset list through the GitHub API. Delete only that confirmed unpublished `v0.1.0` draft, leave the tag untouched, rerun the tag workflow, and use its new exact run attempt. Never use this cleanup path after publication.
