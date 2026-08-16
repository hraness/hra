# Contents

- `local-human.ts` – signed local WorkOS and Convex acceptance across browser-authenticated human administration plus isolated worker and reviewer `taskctl` subprocesses.

# Guidelines

- Run this acceptance only through the web workspace's local signed-provider runner; never add an unsigned human identity shortcut.
- Route only the two public WorkOS device endpoints to the loopback fixture and leave every Convex request on the configured local site origin.
- Keep access, refresh, enrollment, and credential material out of stdout, stderr, thrown messages, and command-line arguments.
- Use an isolated temporary configuration root and verify every persisted secret-bearing file is an owned regular file with mode `0600`.
- Prove human and agent authentication remain distinct by continuing agent work after switching the human to another organization.
- Drive task creation, dependency, claim, submission, review, acceptance, and readiness through real subprocess invocations; do not replace task transitions with direct HTTP calls.
- Keep the final `TASKCTL_SIGNED_ACCEPTANCE_PROOF` marker versioned, machine-readable, and limited to public workspace/task identifiers plus status and revision fields.
