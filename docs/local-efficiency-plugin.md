# HRA local efficiency plugin

The repository marketplace distributes `hra-local-efficiency`, a local-only Codex plugin for machine-wide heavyweight-command scheduling, validation ownership, stale-task audits, and guarded worktree cleanup. It preserves useful agent fan-out and every repository final gate. It does not configure or route cloud execution.

The plugin is separate from the published `@hraness/hra` package. Install the repository marketplace and plugin on each development machine:

```sh
codex plugin marketplace add hraness/hra --ref main --sparse .agents/plugins --sparse plugins/hra-local-efficiency
codex plugin add hra-local-efficiency@hraness
```

Start a new Codex task after installation so Codex discovers the skill. Ask it to install the HRA local efficiency baseline on the Mac. The skill applies one marker-bounded global guidance block, installs the host-runner commands and optional worker profiles, verifies a minimal private scheduler runtime, and leaves unmanaged Codex configuration and global Bun packages unchanged.

From a reviewed repository checkout, maintainers can apply and verify the same bootstrap directly:

```sh
bun run local-efficiency:apply
bun run local-efficiency:check
```

After a marketplace update, refresh the Git snapshot, reinstall the plugin, and start another new task:

```sh
codex plugin marketplace upgrade hraness
codex plugin add hra-local-efficiency@hraness
```

In that new task, invoke `$hra-local-efficiency` and have it run the freshly installed skill's `scripts/bootstrap.ts --apply` followed by `--check`. This repoints the convenience-command symlinks from the prior versioned plugin cache before they are used.

Run the plugin's deterministic test suite before handoff:

```sh
bun run test:local-efficiency-plugin
```

The bootstrap and audits are local operations. Repository adoption changes only the exact `hra-local-efficiency` marker block in a root `AGENTS.md`. Worktree removal remains a separate explicit operation that requires every approved absolute path.
