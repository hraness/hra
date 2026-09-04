# Contents

- Build scripts compile the CLI and generate the static website.
- Check scripts verify package contents, README parity, dependencies, release metadata, and the absence of file-level import cycles under `src/`.
- `check-security-primitives.ts` compares per-file counts of load-bearing security primitives against the reviewed `security-primitives.json` table; a count changes only with a deliberate `--update` after review.
- `check-install-pins.ts` keeps the installer's embedded CLI and normalizer digests equal to the working tree (`--update` re-pins them) and, under a tag ref, proves the public command names the runtime bytes being released.
- The local release-tag helper verifies the immutable owner identity, exact clean current `main`, successful CI, monotonic version, and split provider rulesets before pushing one annotated tag. The tag workflow then creates and proves one GitHub Release and npm publication from the same bytes.

# Guidelines

- Keep scripts deterministic, noninteractive, and safe in a clean clone.
- Parse external command output from `unknown` and name every expected file.
- Do not read credentials, home-directory application state, or provider configuration during ordinary checks.
- A release script derives publication authority only from the immutable owner identity, protected reviewed source, repository-governed trigger, and exact workload identity. It never invents scope or bypasses provider and repository gates, and it does not add a second conversational or repository-variable approval after those gates have authorized the same release.
