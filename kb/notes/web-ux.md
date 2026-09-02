---
title: Web surface UX contract
description: The keyboard-first, TUI-style interaction contract for the HRA browser surface, an enrolled device that renders the compact projection and submits remote commands.
type: note
status: proposed
area: hra
tags:
  - web
  - ux
  - keyboard
  - accessibility
relations:
  related-to: [ plans/hra-v2 ]
---

# Web surface UX contract

This note is the build contract for the HRA web app proposed in [HRA v2](../plans/hra-v2.md). The browser is an enrolled device: it holds its own wrapping key, decrypts the compact projection client-side, and submits durable remote commands to the session's execution custodian. It is never the execution device and never implies that it can start, resume, approve file changes, or take over a session.

Principles: one fixed monospace grid; every action has a key; the mouse is optional; nothing decorative; state is shown as a glyph and a word, never only a color; one status line at the bottom carries identity, device, lease, sync, and mode.

## Layout, modes, and keymap

**Layout.** Fixed 3-pane grid at >=100 columns: left list (sessions or accounts, 28-32 ch), center stream (fluid), right context (32 ch, toggle `\`). Below 100 columns collapse to list <-> detail with `Enter`/`Esc`. Rows are one text line (20 px at 13 px mono). No cards, no shadows, hairline rules only.

**Modes** (vim-like, shown at the far left of the status line): `NORMAL` (single keys act), `INSERT` (compose box has focus; only `Esc`, `Enter`, `Shift+Enter` are special), `PALETTE` (`:` or `Cmd/Ctrl+K`), `FILTER` (`/`), `HELP` (`?`).

**Keymap (NORMAL).**

| Key | Action |
|---|---|
| `j` `k` / `↓` `↑` | move selection; `gg` `G` top/bottom; `Ctrl+d` `Ctrl+u` page |
| `1` `2` `3` | focus sessions / stream / context pane; `Tab` `Shift+Tab` cycle panes |
| `g s` `g a` `g u` `g d` `g c` | go to Sessions, Accounts, Usage, Devices, Commands |
| `Enter` / `l` | open selection; `Esc` / `h` back, clear filter, close overlay |
| `i` | compose (send); `q` queue; `s` steer; all open INSERT with the kind shown |
| `x` | stop: two-step (`x` then `Enter`), shows target session + custodian |
| `p` | preset picker low/high/ultra; `f` toggle fast |
| `y` | yank public id; `Y` yank the exact equivalent `hra remote ...` command |
| `r` | reveal interaction summary; `o` open turn summary (files/git) |
| `/` | filter current list (regex, `!` negates, as k9s) |
| `:` `Cmd/Ctrl+K` | palette: actions + sessions + accounts + devices, fuzzy, shortcuts shown inline |
| `?` | context-sensitive help overlay for the focused pane |
| `.` | repeat last command on current selection |
| `Ctrl+l` | lock: drop in-memory key, show lock screen |

INSERT: `Enter` sends, `Shift+Enter` newline, `Esc` cancels back to NORMAL, `Ctrl+Enter` also sends. 64,000-char limit displayed as `n/64000` when >50%. Single-key shortcuts never fire while any text control has focus.

**Status line (always visible, one row):** `NORMAL │ you@x.y · dev brw_3f1a ● │ sess 12 (3 active) │ mac-mini ● lease f7 · 12s │ cmds 1 pending │ key v1 ready │ sync 2s ago │ ? help`. Offline custodian renders `mac-mini ○ offline 4m` and compose shows `(queued until online)` before `Enter` is accepted.

**Density rules:** 12.5-13 px monospace, line-height 1.35, 8 px horizontal gutters, table columns aligned with `ch` units, timestamps relative and right-aligned, ids as 6-char prefixes expanded on hover/focus, states as glyphs `●` active `◐` idle `○ ` offline `✕` terminal `⚠` gap.

## Reference products and patterns

1. **Linear** - single-key edits (`A`, `S`, `P`, `L`), `G`-prefixed navigation chords, `Cmd+K` as the fallback for everything, and shortcuts shown inline in the menu. Copy: `g` chords, palette lists the key next to each action. [medium.com/linear-app/invisible-details](https://medium.com/linear-app/invisible-details-2ca718b41a44), [shortcuts.design/linear](https://shortcuts.design/tools/toolspage-linear/)
2. **Superhuman** - split views created from a search (`/` then palette "split"), digit keys to switch views, palette as the discovery surface. Copy: `/` filters become saved splits (e.g. "active sessions on mac-mini"). [help.superhuman.com shortcuts](https://help.superhuman.com/hc/en-us/articles/43658258433299-Desktop-Shortcuts), [download.superhuman.com shortcuts PDF](https://download.superhuman.com/Superhuman%20Keyboard%20Shortcuts.pdf)
3. **k9s** - `:` command mode with aliases (`:pod ns`), `/` regex filter with `!` negation, header hotkey legend, bottom breadcrumb, `?` lists hotkeys. Copy: `:` resource jumps (`:s <prefix>`, `:a <label>`), filter grammar, crumbs at the bottom. [k9scli.io/topics/hotkeys](https://k9scli.io/topics/hotkeys/), [github.com/derailed/k9s README](https://github.com/derailed/k9s/blob/master/README.md)
4. **lazygit** - numbered panels (1-5) with the number printed in the corner, `?` help that changes with the focused panel, footer showing the current keys. Copy exactly: pane numbers rendered in the pane title, context-sensitive `?`, footer key hints. [freecodecamp lazygit](https://www.freecodecamp.org/news/how-to-use-lazygit-to-improve-your-git-workflow/), [lazygit discussion 4989](https://github.com/jesseduffield/lazygit/discussions/4989)
5. **Warp** - each command + output is a selectable block navigable with `Ctrl+↑/↓`, copyable per block, palette for the long tail. Copy: each turn (user message + assistant message + turn summary) is one selectable block in the stream; `y` on a block yanks the block's public id; decrypted text never enters the clipboard. [docs.warp.dev blocks](https://docs.warp.dev/terminal/blocks/block-basics/), [docs.warp.dev command palette](https://docs.warp.dev/terminal/command-palette/)
6. **Textual / textual-web** - proof that a TUI vocabulary renders well in a browser; the app runs on the machine and the browser is a view. Contrast for HRA: our browser is an *enrolled device with its own key*, not a remote frame, because the custodian may be offline and the projection is E2E encrypted. [textual.textualize.io blog](https://textual.textualize.io/blog/2024/09/08/towards-textual-web-applications/), [github.com/Textualize/textual-web](https://github.com/textualize/textual-web)
7. **Attio** - `?` anywhere opens the shortcut sheet; 30+ "quick actions" surfaced inside search. Copy: `?` and palette share one registry so the two never drift. [attio.com navigating your workspace](https://attio.com/help/reference/productivity-collaborating/navigating-your-workspace)
8. Command-bar patterns in general (fuzzy match, chained selections as in Tana, inline shortcuts as in Todoist): [maggieappleton.com/command-bar](https://maggieappleton.com/command-bar)

## Wireframes

Screen 1 - Sessions (home), 120 columns:

```
┌1 sessions ─────────────────/ filter───┐┌2 stream · fix-auth-retry · mac-mini ● lease f7 ──────┐┌3 context ──────────────┐
│● fix-auth-retry     acct: work  2m   ││ 14:02 you    Retry the login flow with backoff and     ││ turn 7 · high · fast   │
│● docs-cleanup       acct: work  9m   ││              add a test for the 429 path.               ││ 12.4s                  │
│◐ perf-spike         acct: alt   1h   ││ 14:02 codex  I'll add exponential backoff to             ││ files                  │
│○ old-migration      acct: work  2d ⚠ ││              src/auth/login.ts and cover 429 in          ││  src/auth/login.ts     │
│✕ archived-1         acct: alt   5d   ││              src/auth/login.test.ts ...                  ││  src/auth/login.test.ts│
│                                      ││ 14:03 ⚠ approval  command_approval  pending  rev 3       ││ git                    │
│                                      ││        "bun test src/auth"  · resolve on mac-mini        ││  status · diff         │
│                                      ││ 14:03 turn 7 done · 12.4s · 2 files · 1 git action       ││ pending interactions 1 │
│                                      ││ 14:05 cmd 0191…c2 send  applied ✓                        ││ commands               │
│                                      ││                                                          ││  0191…c2 send applied  │
│                                      ││                                                          ││  0191…d8 steer pending │
│                                      ││ ─ i send · q queue · s steer · x stop · p preset ─────── ││                        │
│                                      ││ >                                                        ││                        │
└──────────────────────────────────────┘└──────────────────────────────────────────────────────────┘└────────────────────────┘
 NORMAL │ you@… · brw_3f1a ● │ sess 5 (2 active) │ mac-mini ● lease f7 12s │ cmds 1 pending │ key v1 ready │ sync 2s │ ? help
```

Screen 2 - Session stream, compose (INSERT), custodian offline, <100 columns:

```
┌2 stream · perf-spike · alt · mbp ○ offline 4m ───────────────────────────────┐
│ 13:40 you    Profile the hot loop and report the top 3 allocations.          │
│ 13:41 codex  Top allocations: (1) Buffer.concat in chunker ... (2) ...       │
│ 13:41 turn 3 done · 41.0s · 1 file                                           │
│ 13:55 cmd 0191…9a stop  expired ✕  (custodian offline past 5m deadline)      │
│                                                                              │
│                                                                              │
│ ─ send (queued until mbp is online · deadline 24h) ────────────────── 118/64000
│ > Also check the retry allocator for the same pattern.█                      │
└──────────────────────────────────────────────────────────────────────────────┘
 INSERT │ Enter send · Shift+Enter newline · Esc cancel │ mbp ○ offline 4m │ cmds 0 pending
```

Screen 3 - Accounts and usage (`g a`):

```
┌1 accounts ──────────────────────────┐┌2 usage · work · observed 09:12 (cloud, ≤24h) ──────────┐┌3 devices ───────────────┐
│● work   plus   w***@x.io   3 sess   ││ limit            used   resets     window                ││● mac-mini  online  f7   │
│● alt    pro    b***@y.io   1 sess   ││ 5h primary      ▓▓▓▓▓▓░░░░ 62%   2h14m   300m           ││● mbp       online       │
│○ spare  free   —           0 sess   ││ weekly          ▓▓▓░░░░░░░ 31%   4d3h    10080m         ││● brw_3f1a  this browser │
│                                      ││ daily tokens (30d)  ▁▂▃▅▇▆▃▂▁▂▄▆█▇▅▃▂▁▁▂▃▄▅▆▇▆▅▃▂▁      ││◌ brw_88e0  pending      │
│                                      ││ lifetime 41.2M · peak 3.1M · streak 12d (best 19d)       ││   approve: hra device   │
│                                      ││ longest turn 214s                                        ││   approve brw_88e0      │
│ a add · l login (local only) ────────││ refresh: run `hra account usage --refresh` on mac-mini   ││ r revoke (type id)      │
└──────────────────────────────────────┘└──────────────────────────────────────────────────────────┘└─────────────────────────┘
 NORMAL │ g s sessions · g u usage · g d devices │ key v1 ready │ sync 5s │ ? help
```

Screen 4 - Palette (`:`) and help (`?`) overlays on top of screen 1:

```
                    ┌ : ─────────────────────────────────────────────┐
                    │ > ste                                          │
                    │ ▸ steer selected session               s       │
                    │   set preset low/high/ultra            p       │
                    │   session: perf-spike (alt)            :s perf │
                    │   stop selected session                x ⏎     │
                    └────────────────────────────────────────────────┘

┌ ? stream pane ───────────────────────────────────────┐
│ j/k move   gg/G ends   Enter open block   y yank      │
│ i send  q queue  s steer  x⏎ stop  p preset  f fast   │
│ r interaction summary   o turn files/git             │
│ Tab/1-3 panes   \ toggle context   / filter   : palette
│ Esc close                                            │
└──────────────────────────────────────────────────────┘
```

## Accessibility

- Lists are React Aria `ListBox` from `@hraness/ui` (roving tabindex, `aria-activedescendant`, type-ahead); `j/k` are added as aliases of arrow keys, never replacements.
- The stream is `role="log"` with `aria-live="polite"` and coalesced announcements (one per turn completion, not per delta), matching the CLI's "coalesces small deltas" rule (`kb/plans/hra-v1.md:90`). Command state changes announce once at terminal state.
- Mode changes (`NORMAL`/`INSERT`/...) are announced via a visually-hidden `aria-live="assertive"` region, one word.
- Focus ring is always visible (no `outline: none`); the focused pane has a distinct border token; `SkipLink` from `@hraness/ui` jumps to each pane. Focus is trapped in palette/help dialogs (React Aria `Dialog`), returned to the prior element on close.
- Every single-key action has a palette entry and a visible `KeyHint` in the pane footer, so shortcuts are discoverable without memorization and available through the palette for switch-access users.
- Color never carries state alone (glyph + word). Respect `prefers-reduced-motion` (no spinners; use text `…`), `prefers-contrast`, and both themes via `data-theme` per the `@hraness/ui` README.
- Confirmations (stop, revoke) are inline in the status line with an explicit `Enter`/`Esc` prompt, not modal dialogs, but still announced.


## Out of scope for this contract

Anything not in the compact projection: provider credentials, raw provider payloads, raw reasoning, approval secrets, permission values, protected answers, environment values, unbounded paths. Invite capabilities and one-time codes exist only inside the input element for the duration of the request and never in the URL, history, analytics, logs, or error reports. Provider email never appears in the page title, tab name, or notifications.
