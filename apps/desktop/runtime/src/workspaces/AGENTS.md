# Contents

- `git-runner.ts` – argument-safe bundled Git process adapter.
- `onboarding-service.ts` – trusted-path repository inspection, opaque local-identity allocation, atomic project onboarding, and bridge-safe result redaction.
- `workspace-broker.ts` – repository validation and replay-safe managed-worktree provisioning.

# Guidelines

- Use the bundled Git binary with argument arrays. Never interpolate cloud or task input into a shell command.
- Resolve and compare canonical repository and git-common-dir paths before mutating Git state.
- Accept onboarding paths only from the trusted native path boundary, reject nested roots and selected symlinks, and never expose canonical paths, Git stderr, or git-common-dir values in bridge results.
- Keep canonical onboarding idempotency inside the atomic local task store. Retry only opaque identifier collisions; fail closed on partial canonical-identity matches.
- Derive app-owned worktree and branch names from validated run IDs. Preserve ambiguous or failed lanes for recovery; never recursively delete a user repository.
- Provision every coding run into an app-owned managed worktree. Keep nullable historical path fields safe for cleanup and recovery, but never treat a missing path or identity as authority to adopt a user checkout.
