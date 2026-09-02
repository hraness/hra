# Contents

- Build scripts compile the CLI and generate the static website.
- Check scripts verify package contents, README parity, dependencies, release metadata, and the absence of file-level import cycles under `src/`.
- `check-security-primitives.ts` compares per-file counts of load-bearing security primitives against the reviewed `security-primitives.json` table; a count changes only with a deliberate `--update` after review.
- `check-install-pins.ts` keeps the installer's embedded CLI and normalizer digests equal to the working tree (`--update` re-pins them) and, under a tag ref, proves the public command names the runtime bytes being released.
- Release helpers read back the tagged commit's successful CI run, then create and prove one GitHub Release and npm publication from the same bytes.

# Guidelines

- Keep scripts deterministic, noninteractive, and safe in a clean clone.
- Parse external command output from `unknown` and name every expected file.
- Do not read credentials, home-directory application state, or provider configuration during ordinary checks.
- A release script verifies; it does not infer permission to publish, deploy, tag, or mutate a provider.
