---
title: Oompa app simplification and inline conversations
tags:
  - app
  - product
  - docs
---

# Oompa app simplification and inline conversations

## Outcome

The web app becomes a single grid of compact session cards that each hold their own conversation. Starting a session asks for a prompt and a machine, nothing else. The reader never locks or unlocks the tab. The homepage shows one compact meter of remaining provider usage across every account and machine, with the next reset and the current throughput, and the settings page shows the detailed breakdown behind it. Codex sessions start on Astra Ultra, Claude sessions on Fable Max, and start-time routing may downshift a well-defined Codex task to Astra Max. The Codex desktop account switch is removed. The website documentation is self-consistent with the shipped product.

Owner request, 2026-09-10 (paraphrased and ordered):

1. Remove the lock concept entirely: no Lock button, lock screen, idle lock or `Ctrl+L`. Enrollment and device approval stay. The tab unlocks itself when it loads.
2. Starting a session and writing a prompt or answer in a card use multi-line text areas.
3. Remove the conversation screen. The conversation lives inline in the card, compact and minimal in the style of Zed's agent panel: scrollable history of prompts and responses, responses collapsed except the latest, and scrolling that works well for long results.
4. Tighten the card header: less padding around the drag handle and the kebab; the subagent chips have too much vertical padding inside and horizontal padding outside.
5. No account picker and no model picker. A machine picker stays. Always use the best model the connected accounts allow: Astra Ultra on Codex, otherwise Fable Max. Internal routing takes care of token savings automatically.
6. No project picker. Assume the Documents directory on macOS, or its equivalent on Linux.
7. A compact homepage meter of net usage remaining across accounts and machines, including Codex reset credits and when limits free up, and the rate of throughput. Clicking it opens a detailed breakdown in Settings.
8. Remove Codex desktop app subscription switching.
9. Make the documentation self-consistent and current. Example: the overview page's Detailed reference only shows licence information.

## Starting evidence

- `main` at `16969b9` (v0.8.0 candidate; the rename and provider-usage foundation are merged). CI speed-up (#177) and release preparation (#176) are in flight and do not touch these surfaces.
- App survey (2026-09-10): the grid composer is a single-line `Input`; the Lock button sits in the grid header and in Settings; `custody-context.tsx` owns the idle lock and `Ctrl+L`; the session screen is a separate route with a `Sheet` for model, Fast, approvals and provider; `transcript-view.tsx` renders every entry expanded with no virtualization; card header padding and the 2.75 rem drag handle live in `session-card.stylex.ts`; there is no "Reviewer badge" component, the chip the owner saw is a subagent chip whose face is the subagent's role (`subagent-chips.tsx`, 2.75 rem tall).
- Daemon survey (2026-09-10): `session.start` requires an explicit account and resolves the default project when none is named; `oompa init --yes` creates the `Documents` default project; the device registry projects accounts and projects without a default flag; `usage:listAccounts` and `usage:listSnapshots` are `active_device` queries not yet named in the app; the hosted usage projection carries limits with primary and secondary windows, reset times, daily tokens and lifetime tokens, and no reset-credit count or velocity; the routing decision is shadow-only; Codex High and Ultra are bound to contract 1 (Sol) since the 2026-09-06 correction, and contract 2 already binds them to Astra Max and Astra Ultra.

## Constraints and decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Lock | Removed. The account key is unwrapped on load whenever the device is active and bound, and dropped on `pagehide` and on an authority failure. `custody.state` becomes `unlocked`, `unlocking`, `unenrolled`. | Owner request. The key never leaves memory and never survives the page, which was the protection the lock added on top of enrollment. |
| Conversation screen | Removed with its route. `#/session/<id>` resolves to the grid and scrolls the card into view. | Owner request; one screen fewer to keep consistent. |
| Card history depth | A card subscribes to the compact tail (as today) and shows what the tail holds. "Earlier" at the top of the conversation loads the full history for that card only. | A grid of cards must not walk every session's history on mount. |
| Collapsed responses | Every closed assistant message except the newest renders as a one-line summary with a chevron; the newest response and the streaming turn stay open. Thinking stays collapsed. | Owner request: scrolling back through long results must be cheap. |
| Composer modes | The grid composer only starts sessions. Follow-ups are typed in the card. | The selected-session steering mode duplicates the inline composer. |
| Per-session controls | The card menu keeps Archive, Rename, Copy id, ordering, Approvals and Provider switch. Model and Fast controls leave the app; the CLI keeps `session model` and `session fast`. | Owner request to remove the model picker; Fast is a Codex service tier, not a token saving. |
| Start target | Machine picker only. The app picks the machine's first signed-in Codex account, else its first signed-in Claude account (Linux only), and the provider's best preset. | Owner request. Account selection stays explicit in the device command, so the daemon contract does not change. |
| Project | The app sends the machine's default project. Registry version 1 gains an optional `defaultProjectPublicId`; an older registry falls back to the first project. The project picker leaves the app. The CLI keeps `project add`, `project list` and `project use` as an advanced path. | Owner does not use projects; `oompa init --yes` already makes `~/Documents` the default. |
| Codex best model | `high` and `ultra` rebind to contract 2 (Astra Max, Astra Ultra). Established sessions keep their bound contract until reselected, exactly as the 2026-09-06 correction did in the other direction. | Owner request supersedes the Sol default. Contract 2 already exists, so no new contract number is needed. |
| Token-saving routing | Browser start only. A new Codex prompt classified as `well_defined` or `mechanical` may start on `high` (Astra Max) only under exact Astra contract 2 bindings; every other shape and any explicit effort mention keeps `ultra`. Settings → New conversations → Automatic effort is the browser-local off switch. An idle CLI start has no prompt and keeps Ultra. | Owner request. Reuses the existing fenced command without a new daemon writer or prompt contract; never moves a live conversation. This replaces the earlier proposed daemon routing setting. |
| Desktop switching | `src/desktop/*`, the `account.switch` and `account.switch-recover` commands, the daemon port, the installation flag and the website section are removed. The `desktop_switch*` tables and their migrations stay (append-only), as do historical fixtures. | Owner request. Schema history is immutable. |
| Usage meter data | The app names `usage:listAccounts` and `usage:listSnapshots`, decrypts the projection with the account key, and derives velocity from consecutive snapshots' lifetime tokens. Codex reset credits ride on an additive optional `resetCredits` field of the projection whose byte bound is raised accordingly. | Reuses the hosted projection that already exists; one small additive daemon change for reset credits. |
| Docs | Each docs page owns at least one Detailed reference that belongs to its task, or none. `project` moves to the status page. Removed features leave the site, README, release notes and kb plans in the same change that removes the code. | Owner request; `docsPathForSection` throws for an unowned section, so the registry stays exact. |

Unchanged: enrollment and `oompa device approve`, encrypted sync, the device-command authority boundary, the frozen compatibility identifiers listed in `kb/plans/oompa-rename.md`, and the CLI session-start contract.

## Phases

### Phase 1. Custody without a lock

- **Scope:** `app/src/custody/custody-context.tsx`, `app.tsx`, `env.ts`, `custody/idle.ts` and `lock-screen*` (deleted), grid and settings Lock buttons, `site/docs-content.ts` sentence about `Ctrl+L`.
- **Acceptance:** an enrolled and bound tab reaches the grid without a click; the account key is wiped on `pagehide` and on an authority error, which shows the enrollment screen with the error; no `lock` member remains in the custody type; `bun test ./app` passes.
- **Status:** Implemented on `claude/app-redesign` (2026-09-10); pull request pending.

### Phase 2. Inline conversation cards

- **Scope:** `session-card.tsx` (conversation region, composer, interaction panel, kebab sheet), new `conversation-view.tsx` derived from `transcript-view.tsx` (collapsed responses, "Earlier" loader, auto-follow), `grid-screen.tsx` (start-only composer as a text area, no selection state), `routing/route.ts` (session route becomes a grid anchor), deletion of `session-screen*`, style tightening for the header, drag handle, kebab and subagent chips.
- **Acceptance:** the grid renders every conversation inline; older responses are collapsed and expand in place; the newest response and a streaming turn are open; a card scrolls independently and follows new output unless the reader scrolled up; `Enter` sends and `Shift+Enter` inserts a newline in every text area; the drag handle and kebab fit in a 2 rem row; subagent chips are 1.5 rem tall; `bun test ./app` and the compiled app check pass.
- **Status:** Implemented on `claude/app-redesign` (2026-09-10); pull request pending.

### Phase 3. Machine-only start

- **Scope:** `model/device-commands.ts` (`sessionStartTargets` becomes per machine with a resolved account and preset), `grid-screen.tsx` picker, `src/cloud/payloads.ts` and `daemon-adapters.ts` (`defaultProjectPublicId` in the registry), `settings-view.ts`.
- **Acceptance:** a machine with a signed-in Codex account starts on that account with `ultra`; a Linux machine with only a Claude account starts on `fable-max`; the payload names the machine's default project, else its first; an old registry without the field still starts; parser and builder tests cover the additive field.
- **Status:** Implemented on `claude/app-redesign` (2026-09-10); pull request pending.

### Phase 4. Astra binding and start-time routing

- **Scope:** 4a updates `src/domain/presets.ts` active bindings for `high` and `ultra`, tests that pin Sol, source-bound labels and documentation. 4b adds a pure browser-start selector using the conservative task-shape classifier, a finite browser-local preference, an effort hint in the grid composer, and an off switch in Settings. The shadow router, daemon settings, CLI prompt contract and device payload shape stay unchanged.
- **Acceptance:** new and explicitly reselected Codex High and Ultra resolve to `gpt-6-astra`; established contract 1 sessions keep Sol until reselected. A browser start may choose High only for a clearly bounded prompt with exact Astra contract 2 High/Ultra bindings. Unknown input or binding, explicit choices and established sessions never downshift. Turning automatic effort off restores Ultra for every new browser start; malformed or unavailable storage fails off. CLI idle starts keep Ultra because they carry no prompt. One ordinary command records its exact preset and contract, without fabricated historical rule provenance or retry after an uncertain result. Focused policy, storage and cross-layer tests plus compiled browser acceptance pass.
- **Status:** 4b implemented on `codex/oompa-start-routing-20260910`; focused validation passed, independent review found no blocker. Converged browser and Required CI acceptance remain pending with the integration owner. 4a is delivered separately.

### Phase 5. Remove desktop switching

- **Scope:** `src/desktop/`, `src/domain/desktop-switch.ts`, CLI parser and renderer entries, daemon command kinds and port, `installation.ts`, live-acceptance installation, tests, website section `desktop-account-switching`, FAQ lines, release notes, `docs/live-acceptance.md`, `AGENTS.md` mentions.
- **Acceptance:** `oompa account switch` is an unknown command; `bun run check` passes; the package inventory pin is updated; no public text names the feature.
- **Status:** Not started.

### Phase 6. Usage meter and breakdown

- **Scope:** `app/src/data/functions.ts` and `data/usage.ts` (queries, decrypt, dedupe by account), `model/usage-meter.ts` (remaining, next reset, velocity, runway), `components/usage-meter.tsx` on the grid header, a Settings "Usage" section with per-account windows, reset countdowns and a throughput sparkline; daemon `src/cloud/usage.ts` version-tolerant `resetCredits` field and its byte bounds, `daemon-adapters.ts` projection.
- **Acceptance:** the grid shows, per provider, remaining percent of the tightest window, time to its reset, reset credits when known, and tokens per minute; the meter states surplus or running out from the runway comparison; clicking it opens `#/settings#usage`; an account seen from two machines appears once; a stale or missing snapshot reads as unknown, never as zero; property tests cover the runway arithmetic.
- **Status:** Not started.

### Phase 7. Documentation consistency

- **Scope:** `site/docs-content.ts` pages and reference ownership, `site/content.ts` sections touched by the phases above, README, `docs/beta-release-notes.md`, `docs/usage-management.md`, `docs/model-routing.md`, `kb/plans/provider-usage-management.md` browser-view note.
- **Acceptance:** every docs page's Detailed reference belongs to its task; no page describes the lock, the conversation screen, the account or project picker, the model sheet, or desktop switching; the generated site check and the public-text scan pass.
- **Status:** Not started.

## Delivery

Each phase is one pull request from `claude/app-redesign-<phase>` against `main`, with the owner identity on every commit and the Required check green. Phases 1 to 3 may ship together because they touch the same files.

## Implementation log

- 2026-09-10: Plan written from the app and daemon surveys. Worktree `hra-worktrees/oompa-redesign`, branch `claude/app-redesign`.
- 2026-09-10: Phases 1 to 3 implemented together. Custody states are `unlocked`, `unlocking`, `unenrolled`; the lock screen, idle timer and shortcut are deleted. `session-card.tsx` holds the conversation (`conversation-panel.tsx` scroller with an "Earlier" loader and anchored scroll; `transcript-view.tsx` folds every closed response except the newest), the composer (`composer-textarea.tsx`, `model/composer.ts`), the interaction panel and a settings sheet limited to approvals and provider. `session-screen.tsx`, `streaming-tail.tsx` and the session route are removed. `sessionStartTargets` is per machine and resolves account, preset and project; the registry projects an optional `defaultProjectPublicId`. Browser acceptance (`scripts/app-browser.ts`) and the product examples render one card for the session views. The React DOM style-boundary hash set gains the new bundle's identifier allocation after a modulo-identifier diff against the reviewed function.
- 2026-09-10: Phase 4b architecture amended after tracing the command boundary: only browser starts have a prompt to classify. The browser selects an already-supported, exact-contract preset before its ordinary command is recorded. The earlier proposal for an active shadow router and `oompa settings routing off` is replaced by a browser-only Automatic effort preference. This preserves explicit callers, the unchanged CLI idle-start contract and shadow-study gates. Default-on absence is distinct from unreadable or malformed preference storage, which fails off; only a finite non-sensitive on/off flag is persisted. No historical routing rule is invented.
- 2026-09-10: Phase 4b focused evidence: policy/storage/builder tests 35/0; app suite 623/0 including its owned production build; classifier, browser source, import policy and release-workflow tests 132/0; typecheck and changed-source lint passed; managed baseline current. The new React DOM resource function fingerprint `38c65e36bdaa72af11d634e191f31be3f940b40a55f8f1061fa0205cef460ad2` matches all six reviewed fixture token structures under consistent identifier bijections, with unchanged pinned renderer source. The compiled-browser gate now checks effort hints and persisted disable/re-enable, including actual Max selection when converged with Astra contract 2. Browser and final CI execution remain owned by integration.
