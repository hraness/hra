# Contents

- `vercel-build.ts` – source-bound Production Convex deployment and anonymous Preview application-build authority.
- `vercel-build.test.ts` – exact environment, process, and provider-target regression coverage.
- `vercel-build.property.test.ts` – total foreign-input and credential-leakage laws.
- `verify-receipt-provider.ts` – mode-0600 candidate custody and count/match-only HRA Convex readback verification.
- `verify-receipt-provider.test.ts` – candidate file, fixed provider query, and secret-exclusion regressions.

# Guidelines

- Permit remote Convex mutation only from Vercel Production with the source-pinned deployment name and a matching production deploy key.
- Keep Preview app-only and anonymous. Refuse every deployment credential, production origin claim, authentication secret, and provider-write capability even when its value is empty. The reviewed public Convex URLs are its only production data-plane inputs.
- Revalidate Production before its nested application build. Strip deploy keys and server-only secrets from the final Next child while retaining the exact checked public Convex and HRA site literals.
- Pass secrets only through inherited process environment. Never put a secret or provider diagnostic in argv, source, or refusal output.
- Keep local application builds non-mutating. The ordinary `build` command must use the application-only entry point.
- Parse all Vercel and Convex environment input as foreign data and fail closed on unrecognized target combinations.
- Derive the HRA-only receipt keyring and provider commitment from one canonical mode-0600 secret file. Verification output contains only exact counts, closed status, and a match bit.
