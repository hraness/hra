---
title: Oompa rename and package separation
tags:
  - delivery
  - compatibility
  - packaging
---

# Oompa rename and package separation

## Outcome

Rename the maintained HRA product to Oompa across the command, package, source, documentation, website, app, integrations, and Hraness organization consumers. Use `oompa.app` as the canonical product domain. The product mark is the orange circle emoji, 🟠; the favicon and branding take their shape and color from it. The organization remains `hraness`.

The intended forward identities are `Oompa`, `oompa`, `@hraness/oompa`, and `hraness/oompa`. New package documentation and metadata serve the local CLI and its public imports. They must not reuse the website's marketing content or ship its implementation. The root README becomes independently package-authored, and the package description has its own authority. This also makes ordinary `npm pack .` safe without a second artifact producer. Standard development metadata is not itself website content; existing production dependency and archive restrictions still apply.

Exhaustive means every maintained old-name reference is either migrated or classified as an exact, tested compatibility or immutable-history obligation. An empty broad search achieved by changing signed data, historical migrations, or published provenance is not acceptance. Historical references must not become a blanket file, directory, package-scope, or Git-history exemption.

## Starting evidence and delivery hold

The local source checkpoint is `6d20f5fcbfb345c5c9b201278604cc131c7abff9`, tree `fd6312fcc7ff531e04a4c8208c655ce4a86a48e9`. It includes the independently reviewed Claude uncertain-write repair and synthetic safety evidence. It is not a published or deployed Oompa artifact.

The separate site header repair in [PR 172](https://github.com/hraness/hra/pull/172), candidate `644f511583236b4e6c1bb7d2eb96a764b6091755`, has independent source review. Its final package inventory gate failed. Neither that candidate nor its previous tests establishes installation or release admission. Its reviewed source can join the renamed integration candidate; every applicable final gate must then pass on the actual combined tree. Do not publish another intermediate old-name release merely to obtain this source.

Old-name release, repository rename, domain promotion, and dependent polish delivery are held until their corresponding rename prerequisites are met. Existing admitted checks may finish under their original owner. Preserve the immutable v0.7.1 artifacts, current production, terminal alias receipts, all user data, and the hosted capacity and activation holds. This rename does not complete or activate the unfinished provider-usage phases.

## Constraints and decisions

- Keep one integration owner for manifests, lockfiles, generated sources, inventory pins, release workflows, and final delivery. Do not rewrite unrelated work or published history.
- Preserve the existing repository's numeric identity if an in-place rename can satisfy legacy recovery. The old tagged installer rejects redirects and requires its original repository path. Repository movement is blocked until a reviewed originating-release recovery path is proved; ordinary Git redirects are insufficient.
- [GitHub's repository rename contract](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository) preserves ordinary Git redirects but does not redirect reusable action calls. Inventory those consumers explicitly.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) binds a package to configured repository and workflow identity. A new coordinate or repository path needs its own supported authority and non-publishing preflight. Preserve authentication, provenance, tag protections, and immutable old artifacts.
- Keep one existing state and daemon-custody root. Do not create a parallel Oompa root beside an existing HRA writer, copy databases, rename provider-owned homes, regenerate keys, or use a symlink as migration authority.
- Existing encryption domains, opaque identifiers, signed cursors, receipts, schema preimages, and recovery journals remain byte-exact until an explicitly versioned migration is proved. Source symbols and filenames may change without changing those values.
- Resolve renamed environment variables before any effect. Preserve absent versus explicitly empty values, retain necessary legacy input compatibility, and reject contradictory aliases. Do not change a user's cloud-disabled setting into hosted enrollment.
- Existing provider sessions retain their exact bound tool manifests and preamble digests. New Oompa contracts need explicit versioned admission and per-session selection, not a global acceptance of two writer namespaces.
- Preserve already-dispatched email body and idempotency bytes. A new Oompa sender presentation or link belongs to a new body version. Do not rerun one-time hosted bootstrap or regenerate authentication secrets to rename presentation.
- Keep the website and authenticated app on separate origins, `oompa.app` and `app.oompa.app`, reusing their existing projects and backend. Existing browser keys are non-extractable and origin-scoped: retain the old origin until supported new-device enrollment and recovery pass. Do not export keys to bridge the domains.
- Fresh domain inventory found website automatic custom-domain assignment disabled and app automatic assignment enabled. Before attaching either new hostname or publishing a rename `main` candidate, stage the app's assignment policy under exact pre-state, conditional intent and readback. A website promotion hold does not govern the app.
- The existing Hraness scheduler remains authoritative during this change. Any renamed plugin entry points must share installed legacy leases and recovery journals until a tested migration retires them.
- Keep public audit evidence free of private repository content, machine paths, credentials, and provider payloads. Private organization inventories stay outside this public repository.

## Open decisions

| Decision | Resolver | Required evidence |
| --- | --- | --- |
| Exact safe originating-release installer recovery across the repository rename | Integration owner and independent release reviewer | Old pending, ambiguous, completed and absent intent fixtures; pinned old bytes and authority; safe failure and rollback; no intent rewrite or speculative install replay |
| Extent of visual replacement beyond the orange-circle identity | Product owner | The orange-circle mark is confirmed; the existing layout versus broader playful treatment is a separate preference |
| New-domain app, authentication and redirect cutover | Site delivery owner | Actual domain/project ownership, TLS, CSP, origin-bound key/enrollment implications, hosted configuration and terminal recovery evidence |
| Complete organization inventory and archived-history treatment | Integration owner | Fresh default-head identities for every organization repository; index omissions and excluded binary/private-data surfaces disclosed |

## Phase map

| Phase | Deliverable | Depends on | Write ownership | Parallel work |
| --- | --- | --- | --- | --- |
| 1 | Exact rename inventory and compatibility contracts | None | Integration owner: inventory checker and compatibility specifications | Read-only consumer and domain audits |
| 2 | Package-only artifact and release-identity migration | None for content separation; 1 for identity migration | Package worker: package documentation and checks; integration owner: installer, manifest, lock, pins and workflows | Phase 3 only after exact disjoint files are assigned |
| 3 | Oompa runtime and tooling identities with old-state safety | 1 | Runtime worker: assigned CLI/domain/plugin modules; integration owner: shared contracts | Phase 2 within the assigned boundary |
| 4 | Orange-circle website and app identity | 1 and confirmed visual scope | UI worker: assigned site/app assets and recipes; site owner: domain operator; integration owner: shared content | Runtime work with no shared contract edits |
| 5 | Organization consumer candidates and backward-compatible cutover prerequisites | 1 and reviewed target contracts; dependency pins wait for 6 | One owner per repository branch; shared baseline source before generated adopters | Disjoint consumer repositories |
| 6 | Exact-source artifact admission and guarded product cutover | 2, 3, 4 and the cutover prerequisites from 5 | Integration owner; one site provider custodian | Independent read-only verification |
| 7 | Remaining consumer delivery and exhaustive closure | 5 and 6 | One owner per repository; integration owner closes the inventory | Disjoint consumer final gates |

## Phase 1: Exact inventory and compatibility contracts

- **Status:** Exact default-head tree census complete for all 52 repositories; full verified text scan and compatibility classification pending
- **Depends on:** None
- **Objective:** Account for every old-name reference and decide its treatment before effects.
- **Scope:** Repository tracked paths and text, the full organization default-head census, runtime/release compatibility specifications, and a closed rename-audit checker.
- **Out of scope:** Provider writes, old-history edits, dormant-feature activation, and archived repository unarchiving.
- **Approach:** Discover domain, package, command, symbol, filename, plugin, workflow, documentation and asset references separately. Distinguish `hra` from the unchanged organization name `hraness`. Bind retained compatibility literals to exact values, consumers and regression tests. Search-index results are discovery, not completeness proof.
- **Acceptance criteria:** Every repository is represented by an exact inspected default head or an explicit coverage blocker. Every retained product identifier has a concrete compatibility or historical reason. The checker rejects newly introduced unclassified names and stale exceptions. The installer and domain cutover decisions are resolved before their operational phase.
- **Validation:** New deterministic and property tests beside the rename checker; `git diff --check`; independent inventory and compatibility review. Retain a fresh organization-head readback for final acceptance.

## Phase 2: Package-only artifact and release identity

- **Status:** Content separation implemented and source-reviewed with focused gates passing; artifact and release-identity admission pending
- **Depends on:** None for the content-only boundary; Phase 1 before any new release identity
- **Objective:** Produce a verified `@hraness/oompa` archive whose content serves package users only.
- **Scope:** Independent root package README and description, package-content admission, archive admission, install/recovery support and release identity.
- **Out of scope:** Website copy reuse, marketing bundles, bootstrap secrets, old-package republication, and arbitrary npm deprecation.
- **Approach:** Author root `README.md` independently of `site/content.ts` and remove the website's README writer, renderer and description-parity contract. Give package claims their own checked source while retaining all website and release-limit coverage at its proper owner. Keep ordinary root packing as the single artifact producer. Both local and release packaging must use package-content admission, preserve the production source allowlist, and verify identical archive bytes. No lifecycle-hook bypass or website build is a substitute for the package boundary.
- **Acceptance criteria:** Archive README equals the independently authored root package README. Website builds cannot overwrite it, and changing website copy cannot change package README or description. Negative tests reject site/preview/dev artifacts and unreviewed metadata. Ordinary `npm pack .` has the same package-only content boundary as release packaging. Actual local and global installation, original-intent recovery, CLI command/version and owned-daemon collection pass.
- **Validation:** `bun run test:package-policy`; focused package-content, installer and release-workflow tests; `bun run check:install-pins`; complete `bun ./scripts/check-package.ts <absolute-reviewed-archive>` through exclusive host compute. Independent raw-member and Git-source archive readers must agree before pinning inventory.

## Phase 3: Runtime and tooling identities

- **Status:** Additive cloud-environment alias and accurate recovery guidance implemented, independently source-reviewed, focused-test and type-check green; other runtime identities not started
- **Depends on:** Phase 1
- **Objective:** Present Oompa consistently while existing state remains recoverable under one authority.
- **Scope:** CLI help and diagnostics, public source symbols and imports, forward environment names, versioned session tool contracts, and plugin command/catalog names.
- **Out of scope:** Provider-owned state, destructive physical state moves, unchanged cryptographic preimages, and new automatic provider actions.
- **Approach:** Centralize forward branding separately from frozen compatibility values. Rename authored source symbols and files with all callers. Admit new provider-visible names only through exact new-session contract selection; retain existing sessions' original contract. Migrate managed guidance from its owning generator before applying it to other repositories.
- **Acceptance criteria:** New commands expose Oompa and the old supported inputs cannot start an independent writer. Conflicting environment aliases fail before effects. Old databases, ciphertext, signed cursors, capability bindings and recovery journals retain their existing meaning. Plugin upgrades do not duplicate host capacity or erase old recovery records.
- **Validation:** Focused CLI, installation, storage-path, daemon-lock, crypto, provider-session, host-tool and plugin tests selected by changed inputs; deterministic old/new contention and property-based alias/contract tests. Required source CI remains complete on both platforms.

## Phase 4: Orange-circle website and app

- **Status:** Site/app orange-circle favicon source and finite app asset admission implemented with focused checks passing; isolated compiled proof, broader branding and rendered acceptance pending
- **Depends on:** Phase 1 and the confirmed visual scope
- **Objective:** Make Oompa recognizable as the orange-circle product across public and operational surfaces.
- **Scope:** Favicon and shared mark, product naming, accessible theme roles, page titles, social cards, metadata, guides, app shell, authentication presentation, and the guarded new-domain contract.
- **Out of scope:** Invented product claims, unrelated layout changes without the design decision, relaxed CSP, reused old email bytes with changed content, and unverified domain activation.
- **Approach:** Use authored vector geometry for the emoji-inspired circle. Keep brand orange distinct from warning and activity semantics, with explicit text or shape for state. Cover light and dark views, small favicon sizes, rendered examples, screen-reader names, discovery files and generated output. Retain the existing separation of site and app security policies.
- **Acceptance criteria:** No old brand survives in a forward rendered page, favicon, app title, share asset or current instruction. Orange-circle branding remains visible at small sizes and in both themes. Contrast and non-color state cues pass. Old-origin encrypted browser key custody has a documented safe pairing/recovery path; no cross-origin private-key export is introduced.
- **Validation:** `bun run test:site`; affected `bun run test:app` cases; `bun run build:site -- --check`; fresh `bun run check:browser` through exclusive browser-auth with the pinned Node, Bun and Chromium, including native custody. Batched visual and independent design review follows the confirmed scope. Live origin, headers, redirect and authentication checks remain separate.

## Phase 5: Organization consumer preparation

- **Status:** Not started
- **Depends on:** Phase 1 and reviewed target contracts. Consumer publication requiring the new artifact depends on Phase 6, not the reverse.
- **Objective:** Prepare every maintained organization consumer and deliver only backward-compatible prerequisites needed for the product cutover.
- **Scope:** Product lists, package imports and lockfiles, repository links, install examples, shared footer registries, plugin marketplaces, skills, generated guidance, workflow references and public domain metadata.
- **Out of scope:** Unrelated product changes, rewriting immutable releases, dumping private source into public reports, and treating archived history as current product truth.
- **Approach:** Start each task-owned branch from the exact repository default head and follow that repository's instructions. Preserve dirty local work. Apply the source baseline first, then regenerate adopters. Prepare new dependency pins as held candidates until their replacement is admitted. Deliver additive origin, subscription-audience and integration compatibility before they become cutover prerequisites, retaining existing users and data. Keep one integration owner per repository.
- **Acceptance criteria:** The complete organization census has a disposition and owned candidate for every affected repository. Necessary central-service origin, audience and integration changes are independently admitted without removing old compatibility. Remaining consumer branches have explicit artifact/domain prerequisites and cannot publish broken links or unavailable pins. Preparation does not count as organization-wide delivery.
- **Validation:** Each repository's exact focused and final gates, lockfile/install proof where dependencies change, link/metadata checks, and a final fresh-head organization rescan. Do not substitute the product repository's tests for consumer validation.

## Phase 6: Admission and cutover

- **Status:** Not started
- **Depends on:** Phases 2 through 4, plus Phase 5's identified backward-compatible cutover prerequisites. Do not require consumers of an unpublished Oompa artifact to ship first.
- **Objective:** Deliver one verified renamed product without losing existing users' data or recovery.
- **Scope:** Final integration, protected merge, repository identity transition, workload trust, canonical immutable artifact, optional exact-byte npm mirror, domain and app cutover, and production readback.
- **Out of scope:** Tag or artifact replacement, secret regeneration, quota increases, speculative retries and dormant-feature activation.
- **Approach:** Finish source and compatibility evidence before any identity effect. Record exact preflight, account/project/repository identities, mutation intent, response and readback at each separate boundary. Reconcile uncertain effects before retry. Preserve old domain serviceability until the documented transition proves the new origin, authentication, recovery and redirect policy.
- **Acceptance criteria:** Fresh exact-head/current-base Required CI and CodeQL pass; the actual merged main passes fresh CI. Installer and package admission use exact bytes and correct new provenance. Supported workload identity is proved before publication. New domain and app identity, headers, health and relevant data invariants pass independent readback. Every old-name deployment or release hold has an explicit disposition. The foundation release alone does not mark unrelated unfinished phases complete.
- **Validation:** Repository final validation in `CONTRIBUTING.md`, separate local installation and native browser gates, reviewed release workflow and originating-release recovery proof, new guarded domain procedure, and independent production readback. Preserve required host lanes and one owner per wait or provider effect.

## Phase 7: Organization delivery and closure

- **Status:** Not started
- **Depends on:** Phases 5 and 6
- **Objective:** Deliver remaining consumers against the admitted Oompa artifact and verified domains, then prove the rename is exhaustive.
- **Scope:** Held consumer dependency pins and links, repository-specific final gates and delivery, fresh organization-head rescan, remaining legacy-reference classification and final user-facing evidence.
- **Out of scope:** Unrelated work, retroactive alteration of immutable history, treating a repository index miss as absence, and claiming unfinished usage features are delivered.
- **Approach:** Rebase or rejoin each prepared branch only after its exact dependency is admitted. Run its required final gates and protected delivery. Rescan the exact resulting default heads, including repositories that had zero search-index results. Every changed head invalidates that repository's earlier final coverage.
- **Acceptance criteria:** Every organization repository has exact final-head coverage or an explicitly disclosed unresolved blocker. Forward references use the admitted Oompa identities. Every retained historical or compatibility literal has reviewed exact scope and supporting evidence. No current task or plan remains silently deferred under a blanket completion claim.
- **Validation:** Each consumer's required final gate and deployment readback where applicable; final independent full-head rename audit; consolidated branch, PR, artifact, domain and production evidence. Notify the user that all work is done only when the original requested usage work and the rename each satisfy their own acceptance criteria.

## Implementation log

- 2026-09-10: Independent package review found two root packing paths and a website-authored root README. Selected an independently authored root package README and description, removing the website writer, so direct packing and release packing share the same safe boundary. The content-only slice may proceed under the existing name before the identity migration; no renamed artifact is admitted. Focused regression work is in progress. Runtime review separately requires exact preservation of old storage, crypto, session-tool, recovery and email contracts until versioned replacements are proved.
- 2026-09-10: The search-index census found 52 organization repositories, including seven archived repositories, with coverage gaps that require exact default-head scanning. Read-only domain review established separate website/app projects, new-domain TLS not yet ready, non-extractable origin-bound browser keys and differing automatic-assignment settings. Split consumer preparation from post-artifact delivery to remove a circular prerequisite: consumers cannot require an admitted new package before that package's own publication can proceed.
- 2026-09-10: Package separation passed seven package-content cases with 142 assertions and 56 affected site-content/build cases with 2,741 assertions, including a genuine pre-fix README overwrite failure and successful-build byte preservation. Scoped lint and independent full source review passed. Both local extracted-archive checks and release preparation use the new independent package-content admission. No package archive, installer, runtime, manifest identity, dependency lock or release workflow was changed by this slice. A new exact public-text allowance for the planned package coordinate retains private-sibling and secret refusal; its source review passed, but the full policy suite's Git-fixture rerun still needs host transport because sandboxed Apple Git emits a rejected temporary-directory warning. No publication is claimed.
- 2026-09-10: The favicon now uses the user-confirmed orange-circle shape and an Oompa accessible name. Its focused static contract passed after failing against the old H mark. This is source evidence only; rendered small-size/light/dark inspection, app favicon admission, broader branding and final browser gates are pending. The cloud-environment alias slice is separately in progress: a captured conflict may not select or start authority, while help, local diagnostics and existing stop controls remain usable.
- 2026-09-10: Package separation is committed in `36e6e88c35cbec0525dc3f41840363dfe142edd5`, not pushed or published. The organization census covers 52 exact default heads, with no truncated trees and unchanged final head readbacks. A bounded GraphQL pilot verified complete UTF-8 source against canonical Git blob hashes and kept the binary response explicitly unscanned; the full-reader source awaits independent review before dispatch. Published originating installers still bind the old GitHub path before local recovery, so repository movement remains a separate unresolved compatibility decision.
- 2026-09-10: The additive `OOMPA_CONVEX_URL` slice passed 52 focused tests with 782 assertions, plus scoped lint and independent production/test source review. Raw conflicts refuse new cloud authority before migration, custody or process startup, while non-authority local controls remain available. Both aliases are captured once; explicit API targets do not consult unrelated ambient settings. Persistent namespaces and existing wire values are unchanged. Forward-alias recovery wording still needs a coordinated follow-up; the final integration, archive and publication gates remain pending.
- 2026-09-10: Follow-up regression evidence caught recovery guidance that mentioned only the old alias. The corrected default action clears both aliases; the self-managed action restores only the validated bound origin through `OOMPA_CONVEX_URL` and clears the legacy alias. Independent byte comparison proved that URL validation, wire shapes, state and effect ordering did not change. All 72 renderer cases, 14 identity-custody cases and 17 selected CLI/daemon cases passed, as did repository type checking and scoped lint. Type checking also caught a test response missing its required request ID; the fixture was corrected without changing its existing-daemon assertions.
- 2026-09-10: The app admits exactly one canonical data-URI favicon pinned to the same reviewed SVG as the site, without a new image origin, public asset type or general inline-asset exception. Thirty builder contract cases passed with 369 assertions after genuine pre-fix refusal. Independent source review and scoped lint passed. The compiled-output check refused an existing output directory without its publication receipt; the directory was preserved, and a fresh exact-source verification tree is the next proof. The browser also refused a standalone data-URL preview; no workaround or rendered acceptance is claimed.
