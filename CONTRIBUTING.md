# Contributing

HRA is in public beta development. Open an issue before a large change so the authority and compatibility boundary can be agreed first.

## Local setup

1. Install Bun 1.3.14.
2. Run `bun install --frozen-lockfile --ignore-scripts`.
3. Run the focused test beside the code you change.
4. Run `bun run check` before submitting a change.

Browser acceptance also requires Node 24.18.1 and the Chromium revision provided
by the pinned Playwright package. Run `node node_modules/playwright-core/cli.js
install chromium` to provision it. Set `BUN_EXECUTABLE_PATH` and
`CHROMIUM_EXECUTABLE_PATH` to the explicit installed executables, then run
`bun run check:browser`. Bun builds the app, site and isolated fixture; the Node
driver verifies their compiled output with fresh browser profiles. Before
acceptance, `test:browser:custody` exercises real cancellation during preparation
and connected browser ownership, plus failure after partial server setup. These
native cases are skipped by ordinary script tests and run only through the
explicit custody command. The runner retains evidence under `tmp/app-browser-*/`
and `tmp/browser-custody-*/` and requires every owned process and listener to
close before reporting acceptance. Uncertain collection stays failed.

## Change requirements

- Add a deterministic regression for each corrected failure.
- Add property tests for new parsers, reducers, state transitions, ordering rules, and serialization laws.
- Update `kb/plans/` when a change alters a recorded product decision or acceptance gate.
- Keep generated files reproducible and include the generator input.
- Do not commit credentials, account identifiers, local paths, transcripts, or provider payloads.

By contributing, you agree that your contribution is licensed under the MIT License.

## Agent-authored changes

Many changes in this repository are drafted by coding agents (Codex and Claude Code) working from `AGENTS.md` and `kb/plans/`. They are reviewed the same way as any other change: a maintainer reads the full diff, the deterministic gate (`bun run check`) must pass on the exact tree, and no phase of a plan is marked complete without the acceptance evidence the plan names. Agent-authored commits carry a `Co-Authored-By` trailer naming the agent. Prose in an agent-authored change follows `WRITING.md` and `STYLE.md` like any other prose.
