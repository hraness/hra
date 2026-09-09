# Contributing

HRA is in public beta development. Open an issue before a large change so the authority and compatibility boundary can be agreed first.

## Local setup

1. Install Bun 1.3.14.
2. Run `bun install --frozen-lockfile --ignore-scripts`.
3. Run the focused test beside the code you change.
4. Complete the applicable final validation below before merge.

## Continuous integration

CI runs the complete gate in four isolated jobs on both macOS and Ubuntu.
Three jobs run `bun run test:source --shard=1/3`, `--shard=2/3` and
`--shard=3/3`. Pinned Bun partitions the complete source-file discovery across
those jobs, retaining serial tests and isolated file globals. The fourth job,
`bun run check:ci-remainder`, runs every other command from `bun run check`,
in its original order. All jobs retain the same pinned dependencies, complete
governed Git history, Linux native verification and 20-minute job limit.
The `Required` check succeeds only when all eight jobs succeed.

The workflow regression tests compare the expanded phase commands with the
full gate and reject omitted or duplicated commands. They also require all
three source shards and prove whole-file coverage and failure propagation with
the pinned runner. Update that contract when changing the gate. Source-file
sharding does not split a large individual test: independent cases still need
separate tests within the unchanged per-test deadline.

## Final validation

Run `bun run check` locally for changes to runtime code, workflows, dependencies,
build inputs, generated code, test behavior, or any other executable behavior.
Retain every explicit local, native, live, and installation acceptance requirement.

Changes limited to documentation or agent guidance, reproducible documentation
catalogs, the version field of an independently versioned plugin manifest, and
documentation-contract assertions updated only for the revised prose may use
complete required CI as the final source aggregate. An independent reviewer must
inspect the complete diff and confirm that no executable behavior or other
excluded input changed. If that scope is uncertain, run the local full gate.

For this narrow class, run the relevant focused contracts locally, including
plugin/adoption validation when applicable and the existing CI command-coverage
and shard-equivalence tests in `scripts/release-workflow.test.ts`. Wait for the
unchanged complete `Required` CI gate on the final PR head and current-base
integration candidate. Confirm the checked tree and expected head at merge;
head or base movement requires fresh matching CI evidence. Record the scope
review and exact check result. This is the final aggregate for that source
change; it does not require a duplicate local full run or establish unperformed
live or installation acceptance. Release, deployment, and production readback
gates remain separate.

## Change requirements

- Add a deterministic regression for each corrected failure.
- Add property tests for new parsers, reducers, state transitions, ordering rules, and serialization laws.
- Update `kb/plans/` when a change alters a recorded product decision or acceptance gate.
- Keep generated files reproducible and include the generator input.
- Do not commit credentials, account identifiers, local paths, transcripts, or provider payloads.

By contributing, you agree that your contribution is licensed under the MIT License.

## Agent-authored changes

Many changes in this repository are drafted by coding agents (Codex and Claude Code) working from `AGENTS.md` and `kb/plans/`. Independent review, including review by a coding agent, covers the full diff; a separate human sign-off is not required for routine authorized delivery. The applicable final validation above must pass on the exact tree, and no phase of a plan is marked complete without the acceptance evidence the plan names. Artifact admission and operational activation follow the separate [release policy](docs/beta-release.md). Agent-authored commits carry a `Co-Authored-By` trailer naming the agent. Prose in an agent-authored change follows `WRITING.md` and `STYLE.md` like any other prose.
