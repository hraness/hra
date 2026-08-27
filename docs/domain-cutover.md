# Retired HRA v0 domain cutover

Status: retired on 2026-08-27.

The former HRA v0 Vercel and Convex resources are permanently retired. They are no longer traffic targets, staging targets, rollback authorities, or release dependencies for current HRA. The checked `hosted:domain-cutover` package entry was removed with this decision.

The retired identities remain here only as safety tombstones:

- GitHub repository ID `1334876494`, retained as the archived `hraness/hra-v0` source and release-history repository;
- Vercel project ID `prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr`;
- Convex project ID `2680173`;
- Convex production deployment ID `4677913`.

Current HRA must reject those numeric provider identities anywhere an operator accepts a target. Do not rename, recreate, reattach, deploy to, or route traffic through a resource that claims one of them. Historical aliases, deployment names, marker shapes, and P, Q, or reverse-cutover evidence do not grant current authority.

The implementation in `scripts/domain-cutover.ts` and its deterministic tests are retained as a non-operational safety record. They document the identity and compensation boundaries that applied before retirement. Do not invoke that source directly for provider work.

Any future domain or release procedure must be current-project-only. It must target the current HRA Vercel project, current HRA Convex project and production deployment, and current HRA repository. It needs a new plan, operator surface, deterministic tests, provider readback contract, and recovery design before use. HRA v0 cannot be introduced as a fallback in that design.
