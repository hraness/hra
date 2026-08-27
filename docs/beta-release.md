# Retired beta release runbook

Status: retired on 2026-08-27 without publication.

The former `v0.1.0` beta process depended on the HRA v0 Vercel deployment, its public fallback, and its paired provider readbacks. That dependency became invalid when HRA v0's Vercel and Convex resources were permanently retired. At retirement, `hraness/hra` had no `v0.1.0` tag, no draft release for that tag, and no published `v0.1.0` release.

The active Release workflow and the public `release:candidate` and `release:publish` package entries were removed. The implementation and deterministic tests under `scripts/` remain only as a safety and design record. They must not be invoked directly to create a candidate, tag, draft, workflow lease, publication, or provider mutation.

Current HRA has no authorized publication path. Before publishing any version, design and review a new current-project-only path that:

- targets only the current HRA repository, Vercel project, Convex project, and Convex production deployment;
- rejects retired HRA v0 project and deployment identities;
- does not require a fallback alias, reverse cutover, or HRA v0 marker;
- defines new candidate, tag, artifact, publication, recovery, and live-acceptance contracts;
- exposes only the operator entries and GitHub workflow needed by that reviewed design; and
- proves the path with deterministic tests and exact live provider readback before its first tag or release.

Until that replacement is accepted and implemented, do not create an HRA version tag, draft, release, or public install claim. Preserve any old local receipts, intents, and evidence files as historical records; they do not authorize replay.
