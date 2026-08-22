# Contents

- `attention-projector.ts` – pure precedence, minimization, aggregation, and canonical ordering for the pathless attention projection.
- `attention-service.ts` – read-only gateway coordinator that joins local snapshots with optional setup and task observations.
- `task-attention.ts` – scope-fenced local and cloud task-summary adapter with no cross-identity cache.
- `*.test.ts` – focused precedence, privacy, aggregate-count, and partial-cloud evidence.

# Guidelines

- Emit at most one item per pane. Preserve this precedence: ambiguous delivery, setup ambiguity, setup approval, setup failure, workspace recovery, chat attention, then queue pause.
- Keep every item pathless and content-free. Never project setup commands or transcripts, task details, queue text, prompts, responses, provider/session identifiers, paths, or account identity.
- Treat setup and task adapters as injected read ports. Do not import their stores or mutate authority through this directory.
- A task or cloud read failure may degrade completeness but must not remove locally derived pane, account, or system attention.
