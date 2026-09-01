# Contents

- `.codex-plugin/plugin.json` defines the plugin identity and presentation metadata.
- `skills/hra-cloud-efficiency/` contains the operating skill, deterministic route gate, private CLI launch guard, managed policy assets, and discovery metadata.

# Guidelines

- Keep the folder, manifest, marketplace entry, and skill identity aligned as `hra-cloud-efficiency`.
- Keep the manifest independently versioned and MIT licensed.
- Use only documented Codex Cloud commands and settings. Do not automate private provider endpoints.
- Keep provider credentials, prompts, transcripts, raw diagnostics, and account identifiers out of repository files and routing reports.
- Keep the launch guard a transparent official-CLI subprocess boundary. It may isolate diagnostics and stdin, but it must not parse provider protocols, retry ambiguous submissions, or hide task creation.
- Validate the manifest and complete skill before handoff. Keep implementation rules in the skill's closest guide.
