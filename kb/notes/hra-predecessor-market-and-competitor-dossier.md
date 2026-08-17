---
title: "HRA predecessor market and competitor dossier"
type: market-research
domain: hra.sh
as_of: 2026-07-19
status: snapshot
description: "Predecessor market map, competitor analysis, strategic options, and validation gaps inherited by HRA."
predecessor_snapshot_sha256: f21c671308af383bc5f50b32701f3f050854c4f91d60bfbd2bf44ee2780d41e4
---

# HRA predecessor market and competitor dossier

## Research boundary

This dossier separates three kinds of claims:

- **Repository fact** describes checked-in product or plan evidence.
- **Market fact** comes from a linked first-party vendor or project source, accessed 2026-07-19.
- **Analysis** is an inference or testable hypothesis, not customer evidence.

OPRTE's protected `VISION.md` is empty. The brand catalog describes a product
that reviews and manages work by coding agents. The accepted
OPRTE Codex runtime plan is unusually specific,
but remains an implementation proposal rather than human-authored vision. This
dossier uses both inputs without silently broadening either one.

## Proposed product and exact customer job

**Repository fact.** The plan defines a macOS control plane over a pinned Codex `app-server`, with one isolated server and `CODEX_HOME` per signed-in account. It proposes managed worktrees, concurrent threads, a global Attention inbox for approvals and questions, explicit restart and recovery, Fast or Ultra selection when supported, fork/promote/discard side chats, and quit/reopen continuity. Codex remains authoritative for authentication, transcripts, and protocol; OPRTE owns supervision, routing, worktree leases, interaction routing, and conservative recovery.

The narrow job is:

> Help one builder safely operate several coding-agent tasks across projects without losing attention, worktree state, account boundaries, or confidence about what can ship.

This is different from “give me an AI editor.” The builder already has one or more model subscriptions and agent harnesses. OPRTE proposes to manage the operational system around them.

## Market definition

The category now has six overlapping layers:

1. **First-party agent applications** own the protocol, account, transcript, and model capabilities.
2. **AI editors** combine interactive editing, agents, review, and background work.
3. **Parallel-agent desktop cockpits** launch agents into isolated worktrees and centralize status, diffs, pull requests, and attention.
4. **Terminal and workspace multiplexers** make any CLI agent observable and scriptable without owning its protocol.
5. **Open-source web control planes** add browser or mobile access to local and remote agents.
6. **Cloud workers** move tasks from the local machine into managed execution and review environments.

**Analysis.** OPRTE's planned feature set is no longer an unoccupied product concept. Worktrees, parallel launch, agent status, diffs, pull requests, notifications, and “needs attention” views appear across direct competitors, including free and open-source tools. The remaining thesis has to be about operational correctness or a sharper owner, not the existence of a cockpit.

## Landscape: exact and adjacent alternatives

The second column is sourced. The final column is analysis.

| Category | Offering | Current product fact | Strategic reading for OPRTE |
| --- | --- | --- | --- |
| First-party control center | OpenAI Codex app | First-party environment for parallel coding agents, local worktrees, cloud environments, skills, and end-to-end engineering tasks ([Codex](https://openai.com/codex/)). | Owns the protocol and can absorb orchestration features without an integration boundary. OPRTE must remain valuable after native improvements. |
| First-party control center | Claude Code desktop | Parallel local or remote sessions, automatic worktree isolation, editor, terminal, previews, pull-request monitoring, and resumable work across desktop surfaces ([desktop](https://code.claude.com/docs/en/desktop), [worktrees](https://code.claude.com/docs/en/worktrees)). | Demonstrates that first-party apps are moving toward full operations surfaces, not staying as chat windows. |
| Direct desktop cockpit | Conductor | macOS app for running Claude Code, Codex, Cursor, and OpenCode in isolated worktrees; includes setup scripts, environment copying, attention/status, diff review, merge, pull-request, and checks workflows ([product](https://www.conductor.build/), [docs](https://www.conductor.build/docs)). | Closest broad commercial competitor. It already owns the provider-neutral parallel-worktree pitch. Public pricing was not located. |
| Direct editor cockpit | Multi | Editor extension supporting many providers, worktree tasks, reusable profiles, subagent supervision, and an “Action Needed” queue for approvals, questions, and step limits ([introduction](https://multi.dev/docs/getting-started/introduction/), [worktrees](https://multi.dev/docs/guides/worktrees/), [actions](https://multi.dev/docs/agents/actions/)). | Directly overlaps worktree profiles and global interaction routing. OPRTE needs deeper protocol, recovery, or account semantics. Public pricing was not located. |
| Direct web cockpit | WorktreeOS | Local daemon and browser UI across projects, worktrees, and agents; groups approvals, supports notifications and inline diffs, and documents mobile access through a Cloudflare tunnel ([product](https://www.worktreeos.dev/)). | Directly overlaps cross-project attention plus mobile operation. OPRTE cannot treat those surfaces as unique. Public pricing was not located. |
| Open-source web cockpit | webmux | MIT-licensed control plane with isolated worktrees, real-time terminals, mobile-friendly Codex and Claude chat, PR/CI/comment context, integrations, Docker, and service health ([product](https://webmux.dev/)). | A zero-license-cost substitute for technical builders. Paid differentiation must be operational trust, support, or semantic depth. |
| Open-source desktop app | Coder Mux | AGPL desktop/browser app for parallel agents in local worktrees, SSH, or isolated workspaces, with multi-model support, git divergence, review, cost visibility, and responsive use ([repository](https://github.com/coder/mux)). | Broad exact-feature pressure with an inspectable codebase. Generic orchestration UI is difficult to price as proprietary value. |
| Terminal multiplexer | cmux | Free GPL native macOS terminal with vertical workspaces, attention rings, unread state, notifications, CLI/socket automation, browser integration, session restore, and support for terminal-based agents; an iOS surface is in beta ([product](https://cmux.com/), [iOS](https://cmux.com/ios)). | Does not need agent protocols to solve much of the attention problem. OPRTE's semantic events must outperform terminal heuristics meaningfully. |
| Terminal worktree launcher | dmux | CLI-oriented workflow for managing parallel development sessions and worktrees ([product](https://dmux.ai/)). | Appeals to builders who prefer composable terminal tools. OPRTE adds value only when a managed GUI reduces real operational error. |
| Native workspace tool | Biome | Desktop environment for orchestrating coding agents and workspaces ([product](https://biomelab.dev/)). | Another entrant competing for the “agent workspace” frame; vendor claims do not establish adoption, but do establish active supply. |
| Open-source operator tools | ax and AO | Agent-oriented terminal or orchestration projects for running and coordinating coding work ([ax](https://jedipunkz.rocks/ax/), [AO](https://aoagents.dev/docs)). | The technical audience can assemble its own control layer. OPRTE must remove enough risk or maintenance to beat composition. |
| Editor extension | Agent Space | VS Code extension offering workspaces for parallel coding-agent activity ([Marketplace](https://marketplace.visualstudio.com/items?itemName=paql4711.agent-space)). | Distribution inside the editor lowers adoption friction. A standalone app needs a cross-editor or cross-project reason. |
| AI editor | Cursor | Integrated editor with local agent modes, cloud agents, automations, model choice, MCP, skills, hooks, and review ([agent overview](https://docs.cursor.com/en/agent/overview), [cloud agents](https://cursor.com/en-US/cloud), [pricing](https://cursor.com/pricing)). | A complete single-vendor workspace. OPRTE should coordinate around existing editors rather than reproduce one. |
| Cloud worker | GitHub Copilot coding agent | GitHub-native background agent that works from issues in an Actions environment and returns branch or pull-request work for review ([official concept](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent)). | Strong issue-to-PR operating path with native governance. OPRTE's opening is local, pre-PR, multi-account, or cross-harness work. |
| Cloud worker | Devin | Cloud coding-agent product with browser, shell, editor, parallel sessions, handoff, and work-management integrations ([introduction](https://docs.devin.ai/get-started/devin-intro), [pricing](https://devin.ai/pricing)). | Sells a managed worker and environment rather than a local harness. It competes for the same “delegate and supervise” budget. |

## Detailed competitor profiles

### Conductor: closest broad commercial substitute

**Market fact.** Conductor runs several named coding harnesses in parallel macOS workspaces backed by git worktrees. Its documentation covers workspace setup scripts, environment transfer, change review, pull requests, checks, and merge workflows. It surfaces agent status and work needing attention.

**Analysis.** Conductor already expresses the intuitive OPRTE pitch: operate several agents without manual worktree plumbing. Provider breadth makes it a safer choice for users who do not want to bet on Codex. OPRTE cannot win by reproducing its visible feature checklist with fewer providers.

**Residual opening.** The plan's separate-account `app-server` topology, protocol-exact interaction registry, and conservative crash/recovery semantics could go deeper than a general harness wrapper. That difference needs forced-failure evidence, not architecture prose.

### Multi: interaction routing is already a product surface

**Market fact.** Multi documents provider profiles, worktree-backed tasks, subagent supervision, and queued “Action Needed” items produced by approvals, questions, and step boundaries.

**Analysis.** This directly challenges the claim that Attention is unique. OPRTE's distinction would have to be stronger state fidelity: exact underlying interaction IDs, account and thread ownership, restart behavior, and no lost or duplicated response after crashes. If users cannot perceive that reliability, Multi's editor-native distribution is stronger.

### WorktreeOS: cross-project and mobile overlap

**Market fact.** WorktreeOS presents agents and worktrees across projects, groups approval needs, supports inline diff review and notifications, and documents browser/mobile access to the local control plane.

**Analysis.** It collapses several seemingly differentiated OPRTE ideas into one direct alternative: a global cockpit, attention, review, and phone access. Its local daemon architecture also makes “local control” non-unique. The relevant comparison is failure behavior and semantic accuracy, not screenshot aesthetics.

### webmux and Coder Mux: open-source price pressure

**Market fact.** webmux is MIT-licensed and Coder Mux is AGPL-licensed. Both expose parallel agent workflows, worktree or isolated environments, review surfaces, and browser-accessible operation.

**Analysis.** The target user is capable of installing open-source developer tools. This makes a paid generic cockpit difficult unless OPRTE provides trusted packaging, deep Codex semantics, data continuity, support, or a workflow that materially increases safe throughput.

### cmux: the protocol-free alternative

**Market fact.** cmux treats each agent as a terminal workload and supplies attention rings, notifications, automation, restoration, and workspace organization without requiring an agent-specific integration.

**Analysis.** Terminal observation is less semantically precise, but extremely compatible. OPRTE's app-server integration adds coupling and version risk; it is justified only when protocol semantics unlock better routing, recovery, or control than generic terminal state.

### First-party Codex and Claude: feature absorption risk

**Market fact.** Codex already provides parallel agent and worktree surfaces. Claude Code desktop documents automatic worktrees, parallel sessions, integrated development surfaces, remote work, and pull-request monitoring.

**Analysis.** First-party products have privileged access to authentication, model modes, transcripts, and new protocol capabilities. OPRTE's defensibility cannot depend on an interface gap remaining open. It needs cross-account, cross-project, reliability, or release-control behavior the model vendor is structurally less motivated to prioritize.

## Capability and distribution comparison

Legend: ✓ is a documented core capability; ◐ is partial, generic, or dependent on the underlying harness; — is not a stated core capability. This does not rate quality.

| Offering | Parallel agents | Isolated worktrees | Global attention | Diff/PR workflow | Mobile/browser | Multi-provider | Protocol-semantic state | Explicit multi-account isolation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Codex app | ✓ | ✓ | ◐ | ✓ | ◐ | — | ✓ | — |
| Claude Code desktop | ✓ | ✓ | ◐ | ✓ | ◐ | — | ✓ | — |
| Conductor | ✓ | ✓ | ✓ | ✓ | — | ✓ | ◐ | — |
| Multi | ✓ | ✓ | ✓ | ✓ | — | ✓ | ◐ | ◐ |
| WorktreeOS | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ | — |
| webmux | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ◐ | — |
| Coder Mux | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ◐ | — |
| cmux | ✓ | ◐ | ✓ | ◐ | ✓ | ✓ | — | ◐ |
| Proposed OPRTE | ✓ | ✓ | proposed | proposed | — | Codex first | proposed | proposed |

## Market dynamics that determine the strategy

### Parallel worktrees are table stakes

Conductor, Multi, WorktreeOS, webmux, Coder Mux, Codex, and Claude all document parallel or isolated work. A worktree launcher may remain a useful component, but it is not a category-level wedge.

### The market is early, fast-moving, and crowded with substitutes

New native apps, editor extensions, terminal tools, and open-source web interfaces can reproduce visible orchestration patterns quickly. Public vendor pages do not establish adoption or durable businesses; they do show that supply is abundant. **Analysis:** building the broadest checklist is a losing race for a small product.

### Semantic integration trades precision for dependency

An `app-server` can expose exact thread, approval, question, and model state. A terminal multiplexer works across providers but infers state. OPRTE's Codex-first choice is rational only if exact semantics produce measurably fewer lost interactions, invalid actions, or recovery mistakes.

### Multi-account operation may be a sharp but small wedge

The planned separate `CODEX_HOME` and server process per account creates a legitimate boundary between identities or subscriptions. **Hypothesis:** only a minority of solo builders need several active accounts often enough to pay. That frequency and legitimacy must be observed before the architecture becomes the headline.

### Recovery is valuable only when failure is consequential

Long-running agents create dirty worktrees, partial tool actions, stale approvals, process crashes, and ambiguous continuation. Competitors market continuity, but public pages rarely specify exact recovery laws. **Analysis:** this is a plausible depth wedge because correctness is hard to demonstrate and maintain. It is also invisible until something goes wrong.

### The operator already pays the model vendor

OPRTE adds another purchase, install, trust boundary, and support relationship. First-party apps bundled into existing model subscriptions and free or open-source alternatives constrain incremental pricing. The economic claim should be time or error saved under sustained concurrency, not “more agents on screen.”

### Local control carries broker responsibility

Managing worktrees, credentials, approvals, cleanup, and publication makes OPRTE a safety-critical broker. Conservative defaults can differentiate it, but one destructive mistake can destroy trust. Property tests, crash injection, and inspectable operations are part of the market promise.

## Strategic options

These are alternative hypotheses, not a plan to build all four.

### 1. Codex reliability appliance

- **Who:** heavy Codex users running several long-lived local tasks, possibly across legitimate account boundaries.
- **Offer:** exact Attention routing, isolated profiles, durable checkpoints, forced-crash recovery, lane preservation, and explicit handoff.
- **Why it could work:** it concentrates on protocol and failure semantics that general worktree launchers may treat shallowly.
- **Hard part:** Codex can absorb the feature, protocol changes create maintenance, and reliability value is difficult to market before failure.
- **Cheapest test:** instrument five builders for a week, inject controlled crashes and dirty-lane conflicts, and compare successful recovery with Codex, Conductor, and Multi.

### 2. Attention router across existing harnesses

- **Who:** builders already using Codex, Claude Code, and terminal agents who do not want another editor.
- **Offer:** normalize only approvals, questions, completion, limits, and failure into one ordered queue; deep-link back to the owning harness.
- **Why it could work:** solves interruption routing while avoiding a full competing workspace.
- **Hard part:** provider-neutral adapters lose semantic fidelity and cmux/Multi/WorktreeOS already cover much of the visible job.
- **Cheapest test:** prototype an event-only menu-bar inbox over two harnesses and measure missed or delayed interactions, not app opens.

### 3. Personal release-control and evidence gate

- **Who:** solo builders whose bottleneck is deciding what agent work is safe to merge or deploy.
- **Offer:** convert finished tasks into a consistent evidence packet—diff scope, checks, unresolved questions, conflicts, preview, and deliberate publish state.
- **Why it could work:** competitors emphasize running work; shipping judgment spans agents, CI, previews, and repository policy.
- **Hard part:** GitHub, editors, and harnesses already own portions of review. OPRTE must integrate rather than duplicate them.
- **Cheapest test:** manually generate the gate for twenty real tasks and measure review time, escaped defects, and abandoned finished work.

### 4. Programmatic workspace broker

- **Who:** technical operators and agent-authored tools that need reliable local account, thread, worktree, and interaction primitives.
- **Offer:** a documented local API or CLI that leases lanes, routes human input, checkpoints state, and exposes safe lifecycle operations.
- **Why it could work:** shifts differentiation below transient UI conventions and lets other interfaces compose the system.
- **Hard part:** smaller developer market, support burden, security surface, and competition from open-source orchestration protocols.
- **Cheapest test:** implement only create/continue/attention/recover primitives for one internal consumer and test invariants under concurrency and crash injection.

## Crowded versus open

**Crowded:** a generic macOS cockpit that starts several agents in git worktrees, shows status, collects notifications, and helps review or merge changes. Conductor, Multi, WorktreeOS, webmux, Coder Mux, cmux, and first-party apps cover most of that surface.

**Potentially open:** unusually correct Codex multi-account and recovery semantics; a minimal cross-harness interaction router; or a release/evidence control layer that proves work is safe to publish. These openings are inferred from public product boundaries and the repository plan. They are not established demand.

**Conclusion.** OPRTE should treat orchestration UI as the shell, not the moat. The strongest current thesis is operational correctness under concurrency and failure. If controlled comparison cannot show fewer lost interactions, safer recovery, or faster confident publication than direct competitors, a broad standalone cockpit is not justified.

## Validation program and unresolved questions

1. Observe five builders who already run at least three concurrent agent tasks. Count missed interactions, context switches, abandoned lanes, duplicated work, and uncertainty about publish state.
2. Run the same weekly workflow in Codex, Conductor, Multi, WorktreeOS, and a terminal-first setup. Document exact residual pain before adding a feature.
3. Test multi-account frequency and legitimacy. Record why accounts are separate, how often simultaneous operation occurs, and whether direct app switching is inadequate.
4. Build a protocol-backed Attention probe before the full app. Verify ordering, ownership, stale items, duplicate delivery, restart continuity, and response acknowledgement against real `app-server` events.
5. Run forced-quit, server crash, deleted-worktree, dirty-lane, usage-limit, corrupt-local-state, and conflicting-handoff drills. Every recovery action needs a deterministic expected result.
6. Test willingness to pay on top of the underlying model plan and against free/open-source substitutes. Use retained weekly operation, not stated enthusiasm for a dashboard.
7. Re-run the competitor comparison before major milestones. First-party feature absorption is a recurring strategic risk, not a one-time research task.
8. Decide which layer OPRTE wants to own: Codex-specific semantics, provider-neutral attention, git/worktree lifecycle, or release evidence. Owning all four initially multiplies failure modes and blurs the buyer promise.

No TAM, adoption, productivity gain, reliability advantage, or willingness-to-pay claim is made here; those facts are not established.

## Source inventory

- [OpenAI Codex](https://openai.com/codex/), accessed 2026-07-19.
- [Claude Code desktop](https://code.claude.com/docs/en/desktop) and [worktrees](https://code.claude.com/docs/en/worktrees), accessed 2026-07-19.
- [Conductor product](https://www.conductor.build/) and [documentation](https://www.conductor.build/docs), accessed 2026-07-19. Public pricing was not located.
- [Multi introduction](https://multi.dev/docs/getting-started/introduction/), [worktrees](https://multi.dev/docs/guides/worktrees/), and [Actions](https://multi.dev/docs/agents/actions/), accessed 2026-07-19. Public pricing was not located.
- [WorktreeOS](https://www.worktreeos.dev/), accessed 2026-07-19. Public pricing was not located.
- [webmux](https://webmux.dev/) and [Coder Mux repository](https://github.com/coder/mux), accessed 2026-07-19.
- [cmux](https://cmux.com/) and [cmux iOS](https://cmux.com/ios), accessed 2026-07-19.
- [dmux](https://dmux.ai/), [Biome](https://biomelab.dev/), [ax](https://jedipunkz.rocks/ax/), [AO](https://aoagents.dev/docs), and [Agent Space](https://marketplace.visualstudio.com/items?itemName=paql4711.agent-space), accessed 2026-07-19. These pages establish project claims, not adoption.
- [Cursor agent overview](https://docs.cursor.com/en/agent/overview), [Cloud Agents](https://cursor.com/en-US/cloud), and [pricing](https://cursor.com/pricing), accessed 2026-07-19.
- [GitHub Copilot coding agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent), accessed 2026-07-19.
- [Devin introduction](https://docs.devin.ai/get-started/devin-intro) and [pricing](https://devin.ai/pricing), accessed 2026-07-19.
- OPRTE Codex runtime plan, repository evidence as of 2026-07-19.
