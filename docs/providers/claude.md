# Claude provider notes

Status: design and probe notes for plan item D3 in `kb/plans/hra-v2.md`. No Claude runtime ships yet.

## Shape

A Claude profile is one isolated home exported as `CLAUDE_CONFIG_DIR`. The user signs in with `claude auth login` inside that home. HRA spawns the unmodified Claude Code runtime bundled with the pinned Agent SDK through HRA's environment-allowlisted spawner, and never reads, copies, or forwards the credential. Account selection stays user-directed. Claude profiles default to a per-account cap of two concurrent sessions; swarm-scale traffic may be judged non-ordinary by the provider, and users raise the cap knowingly.

## macOS Keychain probe (plan item D2)

Question: does a detached daemon spawning the runtime under a per-profile `CLAUDE_CONFIG_DIR` read the directory-keyed Keychain item without prompting?

Recorded so far (2026-09-02, Claude Code 2.1.258, macOS):

- A fresh, empty, mode-0700 `CLAUDE_CONFIG_DIR` fully isolates configuration. `claude auth status` runs non-interactively inside it, reports `loggedIn: false`, creates only `.claude.json`, a lock directory, and `backups/`, and does not touch or prompt for the Keychain.
- The machine's login keychain holds one item for the default configuration, service `Claude Code-credentials`.

Pending, requires the owner to sign in interactively inside an isolated profile home:

- Whether the sign-in stores a directory-keyed Keychain item or a file inside the profile home.
- Whether a detached process with no window server session can read that item without a prompt.

Outcome rule from the plan: if prompts occur, Claude ships Linux-first. HRA never stores a `setup-token` or any other credential under any outcome.
