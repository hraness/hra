# Contents

- `query-kb/` – scoped knowledge-base retrieval.
- `plan-kb/` – durable implementation planning in the knowledge base.
- `percolate-kb/` – evidence-backed concept and relationship promotion.
- `refresh-kb/` – knowledge-graph refresh and validation.
- `save-url-kb/` – auditable public and signed-in web capture.
- `save-pdf-kb/` – auditable PDF conversion with OCR and image evidence.
- `phase-orchestrator/` – phased implementation with bounded Codex collaboration lanes.

# Guidelines

- Keep each portable skill self-contained with `SKILL.md`, its closest `AGENTS.md`, matching `agents/openai.yaml`, and only the references its workflow needs.
- Keep these cross-repository workflows vendored and independently usable; never resolve a skill through a sibling checkout or Git submodule.
- Refresh the KB skills from one reviewed immutable `hraness/kb` release and the orchestration skill from the reviewed portable template, then validate the complete copied directories.
- Keep product-specific operating skills in the root `skills/` directory when present. Portable repository workflows belong here.
- Preserve upstream attribution and license notices for adapted public resources.
