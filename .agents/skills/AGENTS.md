# Contents

- `write-phase-plan/` – dependency-ordered plan authoring with explicit scope, acceptance criteria, validation, and status.
- `phase-orchestrator/` – parent workflow for delegated phased execution, integration, and delivery.
- `phase-implementer/` – bounded implementation worker for one assigned phase.
- `phase-reviewer/` – independent review-and-fix worker for one completed phase.
- `phase-final-reviewer/` – end-to-end reviewer for the completed multi-phase feature.

# Guidelines

- Keep the five skills installed and reviewed as one interoperable pack.
- Keep every skill self-contained with `SKILL.md`, its closest `AGENTS.md`, matching `agents/openai.yaml`, and only the resources it needs.
- Preserve the pinned upstream provenance and MIT license under `phase-orchestrator/`.
- Keep trigger descriptions portable and defer repository commands, validation, version control, and delivery policy to the repository's own guides.
- Keep product-specific operating skills outside this reusable baseline.
