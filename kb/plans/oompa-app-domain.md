---
title: Oompa app domain cutover
tags:
  - delivery
  - compatibility
---

# Oompa app domain cutover

## Decision

The owner selected `oompa.app` on 2026-09-10, replacing the earlier `oompa.dev` choice before the first Oompa CLI release. The website uses `https://oompa.app` and the separate browser app uses `https://app.oompa.app`. Remove the earlier domain bindings without redirects or a compatibility origin. This decision supersedes earlier domain choices in the rename and web plans.

Keep repository and provider numeric identities, the existing backend, account identities, keys, data, state roots, and immutable releases. Existing versioned email bodies and completed historical receipts remain exact; they do not grant the earlier host current authority. Origin-bound browser keys are not exported or copied. The new origin uses normal enrollment and approval.

## Work and acceptance

1. Update current package and website links, canonical metadata, social card, analytics host, app proof, hosted setup input and alias operator. Reject the retired domain at current authority boundaries. Preserve retired operators and completed records as non-operational historical evidence.
2. Add attention body version 3 for the new app host while retaining v1 and v2 replay bytes. Run focused version, retry and malformed-input tests.
3. Publish a new immutable Suite Accounts registry release for the exact `oompa.app` callback. Keep stable `hra` product and client identifiers. Integrate it into Accounts only after artifact admission, with signed-flow, retired-origin refusal and historical email compatibility tests.
4. Validate the converged source with independent review, relevant local tests, compiled browser acceptance and fresh Required CI. Hold v0.8.0 tagging until this replacement candidate reaches reviewed main and passes its exact-main gate.
5. Inspect exact existing Vercel projects, domain ownership, DNS, deployed source and backend configuration. Record mutation intent and recovery evidence. Bind the new hosts to checked deployments, then remove old project-domain and alias bindings without adding redirects. Update only the existing canonical site configuration; do not rerun one-time hosted bootstrap or regenerate secrets.
6. Verify website canonical and app source markers, exact authentication callback/origin, relevant headers and health. Prove the retired hosts no longer serve or redirect the product. Refresh organization consumers against the new domain and record exact final heads.

## Status

Both new hosts are attached to their existing Vercel projects. Website and app promotions of reviewed main `79191891c96bfc2e94fcb6e816d9f2f2516c1dec` completed with project, domain and unrelated alias preservation verified. Automatic custom-domain assignment remains disabled on both projects. The website's public source check passed; the app check exposed the verifier contract mismatch described below. Old domain bindings remain until both complete canonical proofs pass. The immutable [v0.8.0 CLI artifact](https://github.com/hraness/oompa/releases/tag/v0.8.0) is published separately; it does not establish runtime or domain readiness.

The hosted `authority_reduction_hard_quota` hold remains. Domain and artifact delivery do not authorize daemon upgrades, new provider writers, or activation of the unfinished live usage meter.

The app source verifier is being corrected for the current Vercel API contract. Its bulk redirect read requests page 1 with `per_page=10` and requires matching pagination and no redirects or pages. The observed unconfigured HTTP 200 body `{redirects:[],version:null}` is admitted only alongside an authenticated, exact empty versions read; this observed alternative is checked explicitly. The documented [firewall configuration list](https://vercel.com/docs/rest-api/security/returns-activated-waf-config) supplies the full active object, so the verifier retains its existing project, team and redirect checks directly on that object without a second active-endpoint read. Only explicit `{active:null,draft:null,versions:[]}` records absent firewall configuration. Proof schema 3 uses coherent null fields for that absence and rejects older evidence. HTTP errors, redirects, unknown shapes and changes between samples remain refusals. The 91 focused verifier, launcher and CI-equivalence tests, strict TypeScript check, scoped lint and independent review passed. Fresh Required CI and live proof of the repaired merged source remain pending.
