# Contents

- `git-runner.ts` – argument-safe bundled Git process adapter.
- `bundled-bun-workspace-setup.ts` – approval-gated, sandboxed setup execution and generation-fenced recovery.
- `onboarding-service.ts` – trusted-path repository inspection, opaque local-identity allocation, atomic project onboarding, and bridge-safe result redaction.
- `workspace-broker.ts` – repository validation and replay-safe managed-worktree provisioning.
- `workspace-setup-recipe.ts` – immutable-base loading and strict validation for the closed declarative setup recipe.
- `workspace-setup.ts` – revision-bound setup gate and deferred-state contracts used by workspace provisioning.

# Guidelines

- Use the bundled Git binary with argument arrays. Never interpolate cloud or task input into a shell command.
- Resolve and compare canonical repository and git-common-dir paths before mutating Git state.
- Accept onboarding paths only from the trusted native path boundary, reject nested roots and selected symlinks, and never expose canonical paths, Git stderr, or git-common-dir values in bridge results.
- Keep canonical onboarding idempotency inside the atomic local task store. Retry only opaque identifier collisions; fail closed on partial canonical-identity matches.
- Derive app-owned worktree and branch names from validated run IDs. Preserve ambiguous or failed lanes for recovery; never recursively delete a user repository.
- Provision every coding run into an app-owned managed worktree. Keep nullable historical path fields safe for cleanup and recovery, but never treat a missing path or identity as authority to adopt a user checkout.
- Read `.hra/workspace.json` from the immutable base commit. Version 1 permits only `bunInstall` with a frozen lockfile, disabled lifecycle scripts, and bounded timeout and output; never add a shell string, command, argv, environment, hook, or copy surface.
- Require approval bound to the exact setup request, recipe digest, and setup revision before the first effect. If the process can no longer prove whether an effect completed, preserve an ambiguous outcome and require clean-workspace replacement rather than retrying it.
- Run setup with the pinned Bun, an app-owned empty `PATH`, and the packaged macOS sandbox. Keep writes inside the exact managed checkout and setup-private runtime roots, and deny every descendant executable except the pinned Bun.
- Keep packaged setup inside Native's gateway-generation process group. Timeout, output failure, shutdown, or any other unproven post-spawn containment must terminate that generation and leave `effect_started` for restart recovery; never settle a guessed local outcome.
